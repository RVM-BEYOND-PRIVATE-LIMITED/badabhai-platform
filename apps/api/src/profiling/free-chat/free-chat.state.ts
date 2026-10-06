/**
 * The profiling-stage free chat's per-session state (ADR-0051 §3.1) — PURE.
 *
 * WHERE IT LIVES. The mode, the strikes, the cool-down and the counters are one nested key of the
 * profiling envelope (`ProfilingEnvelope.freeChat`), so they ride the same Redis compare-and-swap
 * as the interview itself: a lost CAS re-runs the decision against the winner's state, and a
 * replayed submit never counts a strike twice. Strikes live HERE rather than in the companion's
 * `FaltuStore`, which is left untouched.
 *
 * THE LOCK IS THE ONE DURABLE FACT. Entering `resume` locks the worker into résumé creation until
 * the résumé is done (R5) — across sessions. The envelope dies with its Redis key, so the lock is
 * also written as a sibling key of `chat_sessions.conversation_state` (`free_chat_lock`), merged in
 * after the CAS and spread into every writer that replaces that column ({@link toFreeChatStatePatch},
 * the `toGeneralRoadStatePatch` precedent). See `ChatRepository.findFreeChatLockDecider` for how a
 * new session reads it.
 *
 * NO IMPORTS FROM `conversation-state.ts`: that module imports this one, and the reverse edge would
 * be a cycle. The shapes it needs from the contract are imported from `@badabhai/ai-contracts`.
 */

import { z } from "zod";

import {
  ANSWER_TYPES,
  QuestionPackOptionSchema,
  type AnswerType,
  type InputMode,
  type QuestionPackOption,
} from "@badabhai/ai-contracts";
import {
  FREE_CHAT_MODES,
  FREE_CHAT_MODE_TRIGGERS,
  type FreeChatMode,
  type FreeChatModeTrigger,
} from "@badabhai/types";

/** Trash strikes in one UTC day that start a cool-down (R13). */
export const FREE_CHAT_STRIKES_FOR_COOLDOWN = 3;

/** How long typing is blocked once the cool-down starts (R13). Chips still work. */
export const FREE_CHAT_COOLDOWN_MS = 30 * 60_000;

/** The résumé nudge rides every Nth casual reply (R9). */
export const FREE_CHAT_NUDGE_EVERY = 3;

/**
 * Aside turns one session may serve before free mode answers only with the cap line (ADR-0051
 * §3.6). Sized against the transcript buffer's 600-line ceiling: 60 asides are 120 lines, which
 * leaves the interview behind them the room it has always had.
 */
export const FREE_CHAT_ASIDE_CAP = 60;

/**
 * The interview question a résumé-mode aside re-serves (a deflection, a clarify), held so the
 * re-ask survives the aside overwriting `lastTurn`. Captured from the turn that was on screen when
 * the first aside was served, and cleared the moment a turn passes through to the interview.
 */
export interface FreeChatHeldTurn {
  readonly reply: string;
  readonly kind: "ask" | "disambiguate";
  readonly questionKey: string | null;
  readonly options: readonly QuestionPackOption[];
  readonly answerType: AnswerType | null;
  readonly whyText: string | null;
  readonly inputMode: InputMode;
}

/** A trash-strike tally, scoped to one UTC day (`YYYY-MM-DD`). */
export interface FreeChatStrikes {
  readonly day: string | null;
  readonly count: number;
}

/**
 * The free chat's state inside the envelope. `null` on the envelope (not this object) means "no
 * mode yet": an older client, a session in flight at deploy, or the voice form — the chat stamps
 * such a session `resume` on its first turn and the voice form never stamps it.
 */
export interface FreeChatState {
  readonly mode: FreeChatMode;
  /** Why the CURRENT mode was entered; null for the greeting, which the flow itself opened. */
  readonly trigger: FreeChatModeTrigger | null;
  /** When résumé mode was entered (the lock), ISO-8601; null before. */
  readonly lockedAt: string | null;
  readonly strikes: FreeChatStrikes;
  /** When the cool-down ends, ISO-8601; null when none is running. */
  readonly cooldownUntil: string | null;
  /** Casual model replies served — the every-third nudge's counter. */
  readonly casualReplies: number;
  /** Aside turns served in this session — the per-session cap's counter. */
  readonly asides: number;
  readonly held: FreeChatHeldTurn | null;
  /**
   * The pending question the résumé-mode CLARIFY line was last served for ({@link clarifyKeyOf}),
   * or null. THE CLARIFY CAP: a model that answers garbage fails the same way every time at
   * temperature 0, and its `unclear` arrives as a real call — so an uncapped clarify would loop
   * the worker on "Samajh nahi aaya" until the aside cap. A second unsure verdict for the SAME
   * question passes through to today's interview instead; a different question resets it.
   */
  readonly clarifiedFor: string | null;
}

/**
 * The identity of a pending question for the clarify cap: its pack key when it has one (stable
 * across the retry wording), else its exact text (the opener, a model's question).
 */
export function clarifyKeyOf(question: Pick<FreeChatHeldTurn, "questionKey" | "reply">): string {
  return question.questionKey !== null ? `key:${question.questionKey}` : `text:${question.reply}`;
}

/** A session that has just been offered the greeting ("Shuru karein?"). */
export function greetingState(): FreeChatState {
  return {
    mode: "greeting",
    trigger: null,
    lockedAt: null,
    strikes: { day: null, count: 0 },
    cooldownUntil: null,
    casualReplies: 0,
    asides: 0,
    held: null,
    clarifiedFor: null,
  };
}

/**
 * THE MODE MACHINE: greeting → free | resume, free → resume, and nothing out of resume — the lock
 * (R5). `null` is a session with no mode yet; it may only be stamped `resume` (an older client, a
 * résumé-import opening, a worker already locked) or opened on the greeting.
 */
export function canEnter(from: FreeChatMode | null, to: FreeChatMode): boolean {
  if (from === to) return false;
  if (from === "resume") return false;
  if (to === "greeting") return from === null;
  if (to === "free") return from === "greeting";
  return true;
}

/**
 * The state after entering `to`. Entering `resume` stamps the lock's time once; the counters carry
 * over unchanged (a strike earned in free mode is still a strike). A transition the machine does
 * not allow returns the state as it was — never a throw on the turn path.
 */
export function enterMode(
  state: FreeChatState | null,
  to: FreeChatMode,
  trigger: FreeChatModeTrigger,
  now: Date,
): FreeChatState {
  const base = state ?? greetingState();
  if (!canEnter(state?.mode ?? null, to)) return base;
  return {
    ...base,
    mode: to,
    trigger,
    lockedAt: to === "resume" ? (base.lockedAt ?? now.toISOString()) : base.lockedAt,
    held: null,
    clarifiedFor: null,
  };
}

/** The UTC day a strike is counted against. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Is a cool-down running at `now`? */
export function coolingDown(state: FreeChatState, now: Date): boolean {
  if (state.cooldownUntil === null) return false;
  const until = Date.parse(state.cooldownUntil);
  return Number.isFinite(until) && now.getTime() < until;
}

/** What one counted trash strike did. */
export interface StrikeOutcome {
  readonly state: FreeChatState;
  /** The strike's number within today, 1-based — `strike_count` on the event. */
  readonly count: number;
  readonly cooldownStarted: boolean;
}

/**
 * Count one trash strike (R13). The tally resets on a new UTC day; the third strike of a day — and
 * every one after it — starts a cool-down. The day is the envelope's, so a new session (after six
 * idle hours) starts at zero, which the owner accepted (ADR-0051 §6).
 */
export function registerStrike(state: FreeChatState, now: Date): StrikeOutcome {
  const day = utcDay(now);
  const count = (state.strikes.day === day ? state.strikes.count : 0) + 1;
  const cooldownStarted = count >= FREE_CHAT_STRIKES_FOR_COOLDOWN;
  return {
    state: {
      ...state,
      strikes: { day, count },
      cooldownUntil: cooldownStarted
        ? new Date(now.getTime() + FREE_CHAT_COOLDOWN_MS).toISOString()
        : state.cooldownUntil,
    },
    count,
    cooldownStarted,
  };
}

// ---------------------------------------------------------------------------
// Narrowing — read back from Redis field by field, like every envelope field
// ---------------------------------------------------------------------------

const HeldTurnSchema = z.object({
  reply: z.string().min(1),
  kind: z.enum(["ask", "disambiguate"]),
  questionKey: z.string().nullable(),
  options: z.array(QuestionPackOptionSchema),
  answerType: z.enum(ANSWER_TYPES).nullable(),
  whyText: z.string().nullable(),
  inputMode: z.enum(["text", "options_only"]),
});

const nonNegativeInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

/**
 * The stored free-chat state, or `null`.
 *
 * FAILS TOWARD "NO MODE YET", and that is the safe direction: a session with no mode is stamped
 * `resume` on its next chat turn, which is today's interview. Repairing an unreadable mode to
 * `free` instead would take a worker out of the interview on the strength of a value nothing can
 * vouch for. A `resume` state with no readable lock time keeps the mode and stamps nothing new —
 * the lock was already written when it was entered.
 */
export function narrowFreeChat(value: unknown): FreeChatState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const mode = FREE_CHAT_MODES.find((candidate) => candidate === v.mode);
  if (mode === undefined) return null;
  const strikes = (typeof v.strikes === "object" && v.strikes !== null ? v.strikes : {}) as Record<
    string,
    unknown
  >;
  const held = HeldTurnSchema.safeParse(v.held);
  return {
    mode,
    trigger: FREE_CHAT_MODE_TRIGGERS.find((candidate) => candidate === v.trigger) ?? null,
    lockedAt: isoOrNull(v.lockedAt),
    strikes: {
      day:
        typeof strikes.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(strikes.day)
          ? strikes.day
          : null,
      count: nonNegativeInt(strikes.count),
    },
    cooldownUntil: isoOrNull(v.cooldownUntil),
    casualReplies: nonNegativeInt(v.casualReplies),
    asides: nonNegativeInt(v.asides),
    // A held turn only means something in résumé mode, where it is re-asked.
    held: mode === "resume" && held.success ? held.data : null,
    // Unreadable reads as "never clarified" — at most one extra clarify, never a stuck question.
    clarifiedFor:
      mode === "resume" && typeof v.clarifiedFor === "string" && v.clarifiedFor.length > 0
        ? v.clarifiedFor
        : null,
  };
}

// ---------------------------------------------------------------------------
// The durable lock — `chat_sessions.conversation_state.free_chat_lock`
// ---------------------------------------------------------------------------

/**
 * The lock's persisted shape. A SIBLING KEY of the interview's state, versioned (`v: 1`) and
 * strict, like the general road's stamp: a reader that cannot parse it fails soft to "no lock on
 * this row" and the decider query (which tests the key's presence) still counts the row.
 */
export const FreeChatLockSchema = z
  .object({
    v: z.literal(1),
    locked_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type FreeChatLock = z.infer<typeof FreeChatLockSchema>;

/** The key the lock is stored under — one definition for the writer, the patch and the readers. */
export const FREE_CHAT_LOCK_KEY = "free_chat_lock";

/**
 * The lock patch every REPLACING writer of `conversation_state` spreads — the mid-interview
 * checkpoint, the flush and the abandon sweep — so a whole-column write never erases a lock the
 * jsonb merge already wrote (the `toGeneralRoadStatePatch` precedent).
 *
 * `{}` — THE KEY ABSENT, never null — for every session not in résumé mode, so a pre-ADR session's
 * persisted state is byte-identical to today's. Typed on the one field it reads, so this module
 * stays free of `conversation-state.ts`.
 */
export function toFreeChatStatePatch(envelope: { readonly freeChat?: FreeChatState | null }): {
  free_chat_lock?: FreeChatLock;
} {
  // `?? null`: an envelope built by a caller that predates the field carries it as undefined, and
  // a projection that threw would cost the flush it sits inside.
  const state = envelope.freeChat ?? null;
  if (state === null || state.mode !== "resume" || state.lockedAt === null) return {};
  return { free_chat_lock: { v: 1, locked_at: state.lockedAt } };
}

/** The lock read back off a persisted `conversation_state`, or null — FAILS SOFT, never throws. */
export function readFreeChatLock(conversationState: unknown): FreeChatLock | null {
  if (typeof conversationState !== "object" || conversationState === null) return null;
  const parsed = FreeChatLockSchema.safeParse(
    (conversationState as Record<string, unknown>)[FREE_CHAT_LOCK_KEY],
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Does this row CARRY the lock key at all? Presence, not parse — the same test the decider query
 * makes in SQL, so a row the strict reader cannot parse still counts as locked (the safe side).
 */
export function carriesFreeChatLock(conversationState: unknown): boolean {
  return (
    typeof conversationState === "object" &&
    conversationState !== null &&
    (conversationState as Record<string, unknown>)[FREE_CHAT_LOCK_KEY] != null
  );
}

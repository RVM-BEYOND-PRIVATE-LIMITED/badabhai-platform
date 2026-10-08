/**
 * The free-chat probe's DECISIONS (ADR-0051 §10, #2128) — everything the read-only production probe
 * decides, kept pure so each rule is a unit test rather than a hope about a run against production.
 *
 * WHAT LIVES HERE. The argument contract, the read-only assertion, how a stored event becomes a
 * typed fact, which turns count as "the bot struggled", clarify loops and repeated deflections, and
 * how the sample is drawn. Whether a real line may be SHOWN is `free-chat-probe.mask.ts`'s; the SQL
 * (including how an event is linked to its flushed line) is `FreeChatProbeRepository`'s; the report
 * text is `free-chat-probe.report.ts`'s; the wiring is the CLI's.
 */
import { parseArgs } from "node:util";
import type { CompanionV2ConfidenceBucket, FreeChatMode, FreeChatOutcome } from "@badabhai/types";
import {
  getEventDefinition,
  type AiCostTaskType,
  type EventName,
  type PayloadOf,
} from "@badabhai/event-schema";
import {
  LINE_DROP_REASONS,
  isBlankLine,
  maskSampleLine,
  type LineDropReason,
  type MaskedLine,
} from "./free-chat-probe.mask";

export const FREE_CHAT_PROBE_SCRIPT = "free-chat-probe";

/** R29: "up to 50 recent free-chat messages". `--sample` is refused outside 1..this. */
export const FREE_CHAT_PROBE_SAMPLE_MAX = 50;

/**
 * At most this many struggled turns are examined per requested line. Bounds how much real text
 * one run reads into memory when most lines drop: the run stops reading rather than walking the
 * whole window.
 */
export const SAMPLE_SCAN_FACTOR = 4;

/** The four AI tasks the free chat charges (ADR-0051 §3.3, §8; ADR-0054). */
export const FREE_CHAT_AI_TASKS = [
  "profiling_free_classify",
  "profiling_free_reply",
  "profiling_free_summary",
  "profiling_free_news",
] as const satisfies readonly AiCostTaskType[];
export type FreeChatAiTask = (typeof FREE_CHAT_AI_TASKS)[number];

/**
 * A refusal the probe raises ITSELF — bad arguments, a transaction that is not read-only, part B
 * off the box. Its message is authored here and safe to print. Anything else that fails (a query,
 * the driver) is printed only through `logSafeReason`, which never echoes a bound parameter.
 */
export class ProbeRefusal extends Error {
  override readonly name = "ProbeRefusal";
}

// ---------------------------------------------------------------------------
// The argument contract
// ---------------------------------------------------------------------------

export interface ProbeWindow {
  /** Inclusive. */
  readonly since: Date;
  /** Exclusive. */
  readonly until: Date;
}

export interface FreeChatProbeArgs extends ProbeWindow {
  /** `--sample=N`, or null when part B is off (the default). */
  readonly sample: number | null;
}

/**
 * A UTC date, or an instant with an EXPLICIT offset. A bare local time ("2026-10-07T10:00") is
 * refused: on an operator's laptop it reads as IST, on the box as UTC, and the window would differ
 * by five and a half hours between two runs of the same command.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;
const SAMPLE_VALUE = /^\d{1,3}$/;

/** Strict argv parsing: an unknown flag, a positional or a malformed value is refused, never guessed. */
export function parseFreeChatProbeArgs(argv: readonly string[], now: Date): FreeChatProbeArgs {
  let values: { since?: string; until?: string; sample?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        since: { type: "string" },
        until: { type: "string" },
        sample: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new ProbeRefusal(err instanceof Error ? err.message : String(err));
  }
  if (values.since === undefined) {
    throw new ProbeRefusal("--since=<YYYY-MM-DD | ISO instant with offset> is REQUIRED");
  }
  const since = instantOf("--since", values.since);
  const until = values.until === undefined ? now : instantOf("--until", values.until);
  if (since.getTime() >= until.getTime()) {
    throw new ProbeRefusal("--since must be before --until (which defaults to now)");
  }
  return { since, until, sample: sampleOf(values.sample) };
}

function instantOf(flag: string, value: string): Date {
  const match = ISO_INSTANT.exec(value);
  const ms = Date.parse(value);
  if (match === null || Number.isNaN(ms) || !isCalendarDate(match)) {
    throw new ProbeRefusal(
      `${flag} must be a date (YYYY-MM-DD, read as UTC midnight) or an ISO instant with an offset`,
    );
  }
  return new Date(ms);
}

/** `Date.parse("2026-02-31")` is 3 March; a typo must be refused, not rolled forward. */
function isCalendarDate(match: RegExpExecArray): boolean {
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function sampleOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = SAMPLE_VALUE.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > FREE_CHAT_PROBE_SAMPLE_MAX) {
    throw new ProbeRefusal(`--sample must be an integer in 1..${FREE_CHAT_PROBE_SAMPLE_MAX}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Read-only, asserted
// ---------------------------------------------------------------------------

/**
 * Refuse unless `current_setting('transaction_read_only')` read `on`.
 *
 * The transaction is OPENED read-only; this checks that it IS, from the server's own answer. A pooler
 * that dropped the `SET TRANSACTION`, a driver that ignored the access mode, or a future edit that
 * lost it all read `off` — and the probe stops before its first read of a business table.
 */
export function assertReadOnlyTransaction(setting: unknown): void {
  if (setting === "on") return;
  throw new ProbeRefusal(
    `REFUSING: the transaction is not read-only (transaction_read_only=${
      typeof setting === "string" ? JSON.stringify(setting.slice(0, 16)) : typeof setting
    }); nothing was read.`,
  );
}

// ---------------------------------------------------------------------------
// Stored events → typed facts
// ---------------------------------------------------------------------------

/** One `events` row as the repository reads it. The payload is untrusted until parsed. */
export interface StoredEventRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly version: number;
  readonly payload: unknown;
}

/** One event whose payload passed the registry's own schema for its version. */
export interface ProbeEvent<N extends EventName> {
  readonly id: string;
  readonly occurredAt: Date;
  readonly payload: PayloadOf<N>;
}

export type TurnServedEvent = ProbeEvent<"chat.free_chat_turn_served">;
export type ModeChangedEvent = ProbeEvent<"chat.free_chat_mode_changed">;

export interface ProbeEvents<N extends EventName> {
  readonly events: ProbeEvent<N>[];
  /** Rows of a version this probe was not written for — counted, never misread. */
  readonly otherVersions: number;
  /** Rows of the right version whose payload fails the registry's schema. */
  readonly unreadable: number;
}

/** The slice of a Zod schema this needs — so the api takes no direct dependency on Zod's types. */
interface PayloadParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * Narrow stored rows through the EVENT REGISTRY — the same version and payload schema the emitter
 * validated against — rather than reading JSON keys by hand. A row of another version is set aside
 * (a v2 may move a field this probe would otherwise misread), and a payload the schema refuses is
 * counted, so a report never quietly sums what it could not read.
 */
export function readProbeEvents<N extends EventName>(
  name: N,
  rows: readonly StoredEventRow[],
): ProbeEvents<N> {
  const definition = getEventDefinition(name);
  const schema = definition.payload as unknown as PayloadParser<PayloadOf<N>>;
  const events: ProbeEvent<N>[] = [];
  let otherVersions = 0;
  let unreadable = 0;
  for (const row of rows) {
    if (row.version !== definition.version) {
      otherVersions += 1;
      continue;
    }
    const parsed = schema.safeParse(row.payload);
    if (parsed.success)
      events.push({ id: row.id, occurredAt: row.occurredAt, payload: parsed.data });
    else unreadable += 1;
  }
  return { events, otherVersions, unreadable };
}

// ---------------------------------------------------------------------------
// Which turns the bot struggled with
// ---------------------------------------------------------------------------

/** The outcomes that mean the bot did not understand or could not answer (R29). */
const STRUGGLED_OUTCOMES: ReadonlySet<FreeChatOutcome> = new Set<FreeChatOutcome>([
  "clarify",
  "fallback",
  "deflected",
]);

/**
 * The bucket of verdicts the router ACTED ON with the least certainty.
 *
 * `lt50` is below the router's floor (`FREE_CHAT_MIN_CONFIDENCE`, 0.6), so such a verdict is always
 * served as a clarify — already caught by its outcome — except distress, which bypasses the floor and
 * is never sampled. `50_70` straddles the floor: 0.5-0.6 is clarified, 0.6-0.7 is acted on. An
 * acted-on verdict in this bucket is the one most likely to have been acted on WRONGLY.
 */
export const LOW_ACTED_CONFIDENCE_BUCKET: CompanionV2ConfidenceBucket = "50_70";

type TurnFacts = Pick<
  PayloadOf<"chat.free_chat_turn_served">,
  "outcome" | "decided_by" | "confidence_bucket" | "category"
>;

/**
 * R29's "messages the bot struggled with": a clarify, a fallback line or a deflection; an
 * unavailable classifier; or a classifier verdict in {@link LOW_ACTED_CONFIDENCE_BUCKET} that was
 * acted on. NEVER a distress turn, whatever else it carries — a worker's distress message is not
 * material for a prompt review, and it is the last thing a reviewer should be shown.
 */
export function isStruggledTurn(turn: TurnFacts): boolean {
  if (turn.category === "distress") return false;
  return (
    STRUGGLED_OUTCOMES.has(turn.outcome) ||
    turn.decided_by === "fallback" ||
    (turn.decided_by === "classifier" &&
      turn.confidence_bucket === LOW_ACTED_CONFIDENCE_BUCKET &&
      turn.outcome !== "clarify")
  );
}

/** Oldest first; the event id breaks a tie so every run orders a session the same way. */
function chronological(a: ProbeEvent<EventName>, b: ProbeEvent<EventName>): number {
  return a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id);
}

/** Newest first — the sample's order. */
export function newestFirst(a: ProbeEvent<EventName>, b: ProbeEvent<EventName>): number {
  return chronological(b, a);
}

/** The window's turns grouped by session, each session's turns oldest first. */
function turnsBySession(turns: readonly TurnServedEvent[]): Map<string, TurnServedEvent[]> {
  const sessions = new Map<string, TurnServedEvent[]>();
  for (const turn of turns) {
    const list = sessions.get(turn.payload.session_id);
    if (list === undefined) sessions.set(turn.payload.session_id, [turn]);
    else list.push(turn);
  }
  for (const list of sessions.values()) list.sort(chronological);
  return sessions;
}

/** A worker message that is not a greeting — the denominator of every struggle rate. */
export function isWorkerMessage(turn: Pick<TurnFacts, "outcome">): boolean {
  // The greeting is served at session open (or as the identity intake's handoff): no message of the
  // worker's stands behind it.
  return turn.outcome !== "greeting";
}

/**
 * The modes in which EVERY worker message is answered by the free chat and records a served turn:
 * the greeting and free mode. A message there either gets an aside (one event) or enters résumé
 * mode. In résumé mode a message the interview answers records nothing here, so two résumé-mode
 * events in a row may have any number of unseen interview turns between them.
 */
const FULLY_RECORDED_MODES: ReadonlySet<FreeChatMode> = new Set<FreeChatMode>(["greeting", "free"]);

export interface RunStats {
  /** Sessions with at least one run of 2+ consecutive clarify turns. */
  readonly sessions: number;
  /** The longest such run anywhere in the window (0 when there is none). */
  readonly longest: number;
}

/**
 * CLARIFY LOOPS — two or more clarify lines back to back in the greeting or free mode: the bot said
 * "samajh nahi aaya" and still did not understand the next message. Counted only where adjacency is
 * real ({@link FULLY_RECORDED_MODES}); any other served turn or a mode change breaks the run. A
 * résumé-mode clarify can never loop by construction — it is capped at once per pending question,
 * and the next unsure answer passes to the interview, unseen here.
 */
export function clarifyLoops(turns: readonly TurnServedEvent[]): RunStats {
  let sessions = 0;
  let longest = 0;
  for (const list of turnsBySession(turns).values()) {
    let run = 0;
    let best = 0;
    let mode: FreeChatMode | null = null;
    for (const { payload } of list) {
      const counts = payload.outcome === "clarify" && FULLY_RECORDED_MODES.has(payload.mode);
      run = counts ? (payload.mode === mode ? run + 1 : 1) : 0;
      mode = payload.mode;
      best = Math.max(best, run);
    }
    if (best >= 2) {
      sessions += 1;
      longest = Math.max(longest, best);
    }
  }
  return { sessions, longest };
}

export interface RepeatStats {
  /** Sessions with 2+ turns of the outcome. */
  readonly sessions: number;
  /** The most such turns in any one session (0 when there is none). */
  readonly most: number;
}

/**
 * Sessions with two or more turns of one outcome — ADJACENCY UNKNOWN. Used for deflections: they are
 * served in résumé mode, where the interview's own turns between two of them record nothing here
 * (and a deflection is capped at twice per pending question), so "in a row" cannot be read off the
 * events. This counts repeats honestly instead of claiming streaks.
 */
export function repeatedOutcome(
  turns: readonly TurnServedEvent[],
  outcome: FreeChatOutcome,
): RepeatStats {
  let sessions = 0;
  let most = 0;
  for (const list of turnsBySession(turns).values()) {
    const n = list.filter((turn) => turn.payload.outcome === outcome).length;
    if (n >= 2) {
      sessions += 1;
      most = Math.max(most, n);
    }
  }
  return { sessions, most };
}

/**
 * Sessions that reached free mode and never entered résumé mode in the window — the workers who
 * chatted and never started the résumé. Read from BOTH events, because each records the mode
 * independently and either can fail to be recorded (the emitters never throw).
 */
export function sessionsFreeWithoutResume(
  changes: readonly ModeChangedEvent[],
  turns: readonly TurnServedEvent[],
): number {
  const free = new Set<string>();
  const resume = new Set<string>();
  const mark = (sessionId: string, mode: string) => {
    if (mode === "free") free.add(sessionId);
    if (mode === "resume") resume.add(sessionId);
  };
  for (const change of changes) mark(change.payload.session_id, change.payload.to);
  for (const turn of turns) mark(turn.payload.session_id, turn.payload.mode);
  let count = 0;
  for (const sessionId of free) if (!resume.has(sessionId)) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Drawing the sample
// ---------------------------------------------------------------------------

/** What the repository is asked to link: one served turn, by its session and its event time. */
export interface LinkRef {
  readonly sessionId: string;
  readonly occurredAt: Date;
}

/**
 * One turn's link, as the repository resolved it (the rule is `FreeChatProbeRepository`'s header):
 *   - `linked`: the turn's OWN flushed worker line, proven so — that line (text as stored, possibly
 *     blank) and the bot line before it;
 *   - `ambiguous`: which line this turn answered cannot be proven (two candidates, or lines and
 *     served turns out of balance before it) — nothing is shown;
 *   - `none`: no flushed line lies there (the session was never flushed, or its buffer lapsed).
 */
export type LinkResult =
  | {
      readonly kind: "linked";
      /** Internal only — two events must never print one row twice. Never printed. */
      readonly messageId: string;
      readonly workerText: string;
      readonly botText: string | null;
    }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "none" };

/** How many turns link to no line, and how many are ambiguous. Counts only; reads no text. */
export interface LinkCounts {
  readonly none: number;
  readonly ambiguous: number;
}

export interface SampleSources {
  /**
   * May this worker's lines be sampled AT ALL (owner ruling R36)? Asked first — before the link
   * counts, and before any link, text read or decrypt for the worker.
   */
  readonly eligible: (workerId: string) => Promise<boolean>;
  /** Each ref's link, aligned with the input. Text is read only for a proven link. */
  readonly linkedLines: (refs: readonly LinkRef[]) => Promise<readonly LinkResult[]>;
  readonly linkCounts: (refs: readonly LinkRef[]) => Promise<LinkCounts>;
  /** The worker's decrypted name, or null when none is on file or it cannot be decrypted. */
  readonly knownName: (workerId: string) => Promise<string | null>;
}

export interface SampleEntry {
  /** 1..N — the only handle a sampled line has. Never an event, session or worker id. */
  readonly ordinal: number;
  readonly turn: TurnFacts & Pick<PayloadOf<"chat.free_chat_turn_served">, "mode">;
  /** The bot's previous line: shown, withheld (with why), or null when there was none. */
  readonly bot: MaskedLine | null;
  readonly worker: string;
}

/**
 * A worker line that could not be shown: the worker is not eligible (R36), the link is unproven or
 * absent, the linked line is blank, or the mask refused it.
 */
export type WorkerDropReason =
  | "not_eligible"
  | LineDropReason
  | "ambiguous_link"
  | "no_linked_text";
export const WORKER_DROP_REASONS: readonly WorkerDropReason[] = [
  "not_eligible",
  ...LINE_DROP_REASONS,
  "ambiguous_link",
  "no_linked_text",
];

export interface FreeChatSample {
  readonly requested: number;
  /** Struggled turns in the window (distress turns never count). */
  readonly struggled: number;
  /** Of those, how many belong to a worker who may be sampled (R36). The link counts cover these only. */
  readonly eligible: number;
  /** Of the ELIGIBLE, how many link to NO flushed line: the session was never flushed, or its buffer lapsed. */
  readonly noLinkedText: number;
  /** Of the ELIGIBLE, how many have an unproven link (see {@link LinkResult}), so link to none. */
  readonly ambiguous: number;
  /** How many struggled turns were looked at before N were shown or the scan bound was reached. */
  readonly examined: number;
  readonly entries: SampleEntry[];
  readonly workerDrops: Record<WorkerDropReason, number>;
  /** Bot context lines withheld beside a worker line that WAS shown. */
  readonly botWithheld: Record<LineDropReason, number>;
}

const zeroed = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const linkRefOf = (turn: TurnServedEvent): LinkRef => ({
  sessionId: turn.payload.session_id,
  occurredAt: turn.occurredAt,
});

/** `read`, run at most once per key for the run — one eligibility check, one decrypt per worker. */
function memoised<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const seen = new Map<string, Promise<T>>();
  return (key) => {
    let pending = seen.get(key);
    if (pending === undefined) {
      pending = read(key);
      seen.set(key, pending);
    }
    return pending;
  };
}

/**
 * Up to `size` masked lines from the newest struggled turns.
 *
 * ELIGIBILITY FIRST (R36), for every struggled turn — two columns per worker, no text. A worker who
 * may not be sampled is left out of everything after it: the link counts, every link, every text
 * read and every decrypt. The link counts then cover the eligible turns only, so the report's link
 * figures are never mixed with turns the probe was not allowed to link.
 *
 * Then, in batches of `size`, newest first, stopping at `size` shown lines or after
 * `size × SAMPLE_SCAN_FACTOR` examined turns: the links for the batch's eligible turns, then the
 * mask. A worker line that cannot be shown is skipped WHOLE (its turn gets no ordinal) and its reason
 * counted. A bot line that cannot be shown is withheld beside a worker line that can, and counted
 * apart. A row two events both claim is never printed twice: the second claim counts as an ambiguous
 * link (the repository's rule already prevents it; this is the floor under it).
 */
export async function drawFreeChatSample(
  turns: readonly TurnServedEvent[],
  size: number,
  sources: SampleSources,
): Promise<FreeChatSample> {
  const struggled = turns.filter((turn) => isStruggledTurn(turn.payload)).sort(newestFirst);
  const eligibleWorker = memoised(sources.eligible);
  const allowed: boolean[] = [];
  for (const turn of struggled) allowed.push(await eligibleWorker(turn.payload.worker_id));
  const eligible = struggled.filter((_, i) => allowed[i]);
  const counts =
    eligible.length === 0
      ? { none: 0, ambiguous: 0 }
      : await sources.linkCounts(eligible.map(linkRefOf));

  const entries: SampleEntry[] = [];
  const workerDrops = zeroed<WorkerDropReason>(WORKER_DROP_REASONS);
  const botWithheld = zeroed<LineDropReason>(LINE_DROP_REASONS);
  /** Every row a turn has linked to — internal ids, never printed. */
  const claimedRows = new Set<string>();
  const nameOf = memoised(sources.knownName);

  const scanLimit = Math.min(struggled.length, size * SAMPLE_SCAN_FACTOR);
  let examined = 0;
  while (entries.length < size && examined < scanLimit) {
    const start = examined;
    const batch = struggled.slice(start, Math.min(start + size, scanLimit));
    const linkable = batch.filter((_, i) => allowed[start + i]);
    const links = linkable.length === 0 ? [] : await sources.linkedLines(linkable.map(linkRefOf));
    let next = 0;
    for (const [i, turn] of batch.entries()) {
      if (entries.length >= size) break;
      examined += 1;
      if (!allowed[start + i]) {
        workerDrops.not_eligible += 1;
        continue;
      }
      const link: LinkResult = links[next++] ?? { kind: "none" };
      if (
        link.kind === "ambiguous" ||
        (link.kind === "linked" && claimedRows.has(link.messageId))
      ) {
        workerDrops.ambiguous_link += 1;
        continue;
      }
      if (link.kind === "linked") claimedRows.add(link.messageId);
      if (link.kind === "none" || isBlankLine(link.workerText)) {
        workerDrops.no_linked_text += 1;
        continue;
      }
      const name = await nameOf(turn.payload.worker_id);
      const worker = maskSampleLine(link.workerText, name);
      if (worker.kind === "dropped") {
        workerDrops[worker.reason] += 1;
        continue;
      }
      const bot =
        link.botText === null || isBlankLine(link.botText)
          ? null
          : maskSampleLine(link.botText, name);
      if (bot?.kind === "dropped") botWithheld[bot.reason] += 1;
      entries.push({
        ordinal: entries.length + 1,
        turn: turnFactsOf(turn),
        bot,
        worker: worker.text,
      });
    }
  }
  return {
    requested: size,
    struggled: struggled.length,
    eligible: eligible.length,
    noLinkedText: counts.none,
    ambiguous: counts.ambiguous,
    examined,
    entries,
    workerDrops,
    botWithheld,
  };
}

/** Only the closed enums a sampled line is printed with — never an id. */
function turnFactsOf(turn: TurnServedEvent): SampleEntry["turn"] {
  const { mode, category, decided_by, confidence_bucket, outcome } = turn.payload;
  return { mode, category, decided_by, confidence_bucket, outcome };
}

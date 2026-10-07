/**
 * THE PROFILING-STAGE FREE CHAT'S ROLLING SUMMARY (ADR-0051 §8, Release 2) — PURE: the durable
 * shape, its readers, the carry every replacing writer spreads, and the deterministic gate a
 * model-written summary must pass before a byte of it is stored.
 *
 * WHERE IT LIVES. A sibling key of `chat_sessions.conversation_state` (`free_chat_summary`), the
 * `free_chat_lock` pattern exactly: written by a jsonb `||` merge on the CURRENT session row
 * (`ChatRepository.mergeFreeChatSummary`, monotonic), copied onto a new session at its greeting,
 * and spread by the three writers that replace the column ({@link storedFreeChatSummary}). No
 * migration. Account erasure already removes `chat_sessions`, so the summary goes with it (R23).
 *
 * WHAT IT IS. Model-facing context in compact English notes — the free-mode casual and career talk
 * that aged out of the reply's six-turn window (R21, R22). It is read only by the casual/career
 * reply prompt (R24) and is NEVER shown to the worker.
 *
 * NO NEST, NO I/O: `ChatService` reads and carries it, and `FreeChatSummaryService` folds into it.
 */

import { z } from "zod";

import { redactKnownName } from "../../common/redact-known-name";
import { containsHardIdentifier } from "../resume-import/resume-parse-gates";

/** The key the summary is stored under — one definition for the writer, the carry and the readers. */
export const FREE_CHAT_SUMMARY_KEY = "free_chat_summary";

/**
 * The longest summary the API stores, in UTF-16 units after trim. The SAME bound as the contract's
 * `FreeChatReplyInputSchema.summary` and `FreeChatSummarizeInputSchema.previous_summary`, so a
 * stored summary can always ride back out as either (`free-chat-summary.test.ts` pins the pair).
 */
export const FREE_CHAT_SUMMARY_MAX = 1_200;

/** Aged-out foldable lines a session must hold, beyond what is already folded, before a fold runs. */
export const FREE_CHAT_FOLD_MIN_LINES = 4;

/** Lines one fold may send — the contract's `FreeChatSummarizeInputSchema.turns` cap. */
export const FREE_CHAT_FOLD_MAX_LINES = 24;

/**
 * The persisted shape, versioned (`v: 1`) and strict like the lock: a reader that cannot parse it
 * fails soft to "no summary", which costs the reply its continuity and nothing else.
 *
 * `session_id` names the session whose lines `folded_lines` counts. A summary COPIED onto a new
 * session at its greeting is re-stamped with that session and starts at 0 — the previous session's
 * count says nothing about this one's transcript.
 */
export const FreeChatSummarySchema = z
  .object({
    v: z.literal(1),
    text: z.string().min(1).max(FREE_CHAT_SUMMARY_MAX),
    updated_at: z.string().datetime({ offset: true }),
    session_id: z.string().uuid(),
    folded_lines: z.number().int().nonnegative(),
  })
  .strict();
export type FreeChatSummary = z.infer<typeof FreeChatSummarySchema>;

/** A raw stored summary value, parsed — or null. FAILS SOFT, never throws. */
export function readFreeChatSummaryValue(value: unknown): FreeChatSummary | null {
  const parsed = FreeChatSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The summary read back off a persisted `conversation_state`, or null — FAILS SOFT. */
export function readFreeChatSummary(conversationState: unknown): FreeChatSummary | null {
  if (typeof conversationState !== "object" || conversationState === null) return null;
  return readFreeChatSummaryValue(
    (conversationState as Record<string, unknown>)[FREE_CHAT_SUMMARY_KEY],
  );
}

/**
 * The summary a stored row ALREADY carries, as a spread — the raw value, kept whatever its shape,
 * exactly as `storedFreeChatLock` keeps the lock. Every replacing writer of `conversation_state`
 * (the checkpoint, the flush, the abandon sweep) spreads this, so a whole-column write can never
 * erase a summary the jsonb merge wrote. `{}` — THE KEY ABSENT, never null — on a row without one,
 * so every pre-Release-2 session persists byte-identically.
 *
 * There is NO envelope copy to spread after it: the summary is written off the request path, never
 * through the CAS, so the row is its only home.
 */
export function storedFreeChatSummary(conversationState: unknown): { free_chat_summary?: unknown } {
  if (typeof conversationState !== "object" || conversationState === null) return {};
  const value = (conversationState as Record<string, unknown>)[FREE_CHAT_SUMMARY_KEY];
  return value != null ? { free_chat_summary: value } : {};
}

/**
 * The summary as a NEW session inherits it at its greeting: the same text and time, re-stamped
 * with the new session and starting its count at 0 — `folded_lines` counts only the current
 * session's lines.
 */
export function copiedFreeChatSummary(source: FreeChatSummary, sessionId: string): FreeChatSummary {
  return { ...source, session_id: sessionId, folded_lines: 0 };
}

/**
 * How many of THIS session's foldable lines the stored summary already covers: its count when it
 * was folded in this session, else 0 (a copied summary, another session's, or none).
 */
export function foldWatermarkOf(stored: FreeChatSummary | null, sessionId: string): number {
  return stored !== null && stored.session_id === sessionId ? stored.folded_lines : 0;
}

// ---------------------------------------------------------------------------
// The gate — the model's summary is untrusted input
// ---------------------------------------------------------------------------

/** Every closed reason a model-written summary is refused. Logged; never the text. */
export type FreeChatSummaryRejection = "empty" | "identifier" | "template_token" | "too_long";

/** The gate's decision: the text to store, or one closed reason it was refused. */
export type FreeChatSummaryScreen =
  | { readonly kind: "accept"; readonly text: string }
  | { readonly kind: "reject"; readonly reason: FreeChatSummaryRejection };

const TEMPLATE_TOKEN = /\{\{|\}\}/;

/**
 * Screen one model-written summary (ADR-0051 §8, "Validation"), in this order:
 *
 *   - EMPTY after trim → refused;
 *   - a HARD IDENTIFIER (ADR-0047 G1, `containsHardIdentifier` — PAN, Aadhaar, phone, email, a cued
 *     or credential ID, a GSTIN, a long digit run) → refused. A SCANNER ERROR refuses too: fail
 *     closed, the same rule the reply gate applies;
 *   - a TEMPLATE TOKEN (`{{` / `}}`) → refused: the summary is interpolated into a prompt and must
 *     not carry a placeholder;
 *   - the worker's OWN NAME is redacted (G2, whatever `AI_RAW_PII_ENABLED` says) — a name the model
 *     echoed is removed, not a reason to lose the summary;
 *   - longer than {@link FREE_CHAT_SUMMARY_MAX} AFTER that redaction → refused, so what is stored
 *     always fits back into the reply contract.
 *
 * REFUSED, NEVER REPAIRED (beyond the name): a truncated or scrubbed summary would claim the worker
 * said something the model never wrote. A refusal keeps the previous summary.
 */
export function screenFreeChatSummary(
  raw: string,
  knownName: string | null,
): FreeChatSummaryScreen {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "reject", reason: "empty" };
  if (carriesHardIdentifier(trimmed)) return { kind: "reject", reason: "identifier" };
  if (TEMPLATE_TOKEN.test(trimmed)) return { kind: "reject", reason: "template_token" };
  const text = redactKnownName(trimmed, knownName).trim();
  if (text.length === 0) return { kind: "reject", reason: "empty" };
  if (text.length > FREE_CHAT_SUMMARY_MAX) return { kind: "reject", reason: "too_long" };
  return { kind: "accept", text };
}

/** G1 over the summary. A scanner that errors — or throws — counts as a hit: fail closed. */
function carriesHardIdentifier(text: string): boolean {
  try {
    return containsHardIdentifier(text) !== null;
  } catch {
    return true;
  }
}

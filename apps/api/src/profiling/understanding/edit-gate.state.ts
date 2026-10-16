import { z } from "zod";

import { PROFILING_EDIT_OPS, type ProfilingEditOp } from "@badabhai/types";

/**
 * The edit gate's per-session state (ADR-0057 §3.4, #2312) — PURE, and import-light on purpose.
 *
 * NO IMPORTS FROM `conversation-state.ts` OR THE INTERVIEW'S SERVICES: that module imports this one
 * to narrow the envelope, and the gate's logic (`edit-gate.ts`) reaches the turn service, which
 * imports the envelope back. The `free-chat.state.ts` precedent.
 */

/** The most rows one proposal puts to the worker — a card a worker can still read. */
export const MAX_PROPOSAL_ROWS = 5;

/**
 * One change on a pending proposal. Display text and the value Haan writes, both decided when the
 * proposal was built — so the card shows exactly what will be written, and the write re-checks
 * that the field still says `before` (a mismatch is `stale`, never a blind overwrite).
 */
export interface EditRow {
  /** A pack `question_key`, or `skills` / `experience` for the draft's two lists. */
  readonly key: string;
  readonly op: ProfilingEditOp;
  /** The entry's index in the draft list; null for a pack field. */
  readonly index: number | null;
  readonly label: string;
  readonly before: string;
  /** Null for a removal. */
  readonly after: string | null;
  /** What Haan writes: the text the field's parser reads, the certified skill, the job line. */
  readonly value: string | null;
}

/** A field named as wrong with no new value ("experience galat hai") — asked for on screen. */
export interface EditTarget {
  readonly key: string;
  readonly index: number | null;
  readonly label: string;
  /** What the field holds now — shown with the ask, and re-checked when the answer arrives. */
  readonly before: string;
}

/**
 * The gate's per-session state — one nested envelope key, Redis only (never persisted: a proposal
 * is a question on screen, and a lost envelope simply loses the question).
 *
 * `resumeKey` is the pack question that was on screen when the gate opened; it is served again,
 * unspent, once the gate closes. While `proposal` or `awaiting` is set, `servedQuestionKey` is
 * null — the worker's Haan must never be filed as that question's answer.
 */
export interface EditGateState {
  readonly proposal: { readonly id: string; readonly rows: readonly EditRow[] } | null;
  readonly awaiting: EditTarget | null;
  readonly resumeKey: string | null;
}

const EditRowSchema = z.object({
  key: z.string().min(1).max(64),
  op: z.enum(PROFILING_EDIT_OPS),
  index: z.number().int().min(0).max(63).nullable(),
  label: z.string().min(1).max(200),
  before: z.string().min(1).max(500),
  after: z.string().min(1).max(500).nullable(),
  value: z.string().min(1).max(500).nullable(),
});
const EditGateSchema = z.object({
  proposal: z
    .object({
      id: z.string().uuid(),
      rows: z.array(EditRowSchema).min(1).max(MAX_PROPOSAL_ROWS),
    })
    .nullable(),
  awaiting: z
    .object({
      key: z.string().min(1).max(64),
      index: z.number().int().min(0).max(63).nullable(),
      label: z.string().min(1).max(200),
      before: z.string().min(1).max(500),
    })
    .nullable(),
  resumeKey: z.string().min(1).max(64).nullable(),
});

/**
 * Redis hands back whatever an older build wrote. Anything unreadable is NO GATE — the question is
 * dropped and the interview carries on, never a half-read proposal that Haan could apply.
 */
export function narrowEditGate(value: unknown): EditGateState | null {
  const parsed = EditGateSchema.safeParse(value);
  if (!parsed.success) return null;
  const gate = parsed.data;
  return gate.proposal === null && gate.awaiting === null ? null : gate;
}

/** Is a proposal or an ask on screen? */
export function editGateOpen(gate: EditGateState | null): boolean {
  return gate !== null && (gate.proposal !== null || gate.awaiting !== null);
}

// ---------------------------------------------------------------------------
// The confirmed-change ledger (ADR-0057 R9, #2313)
// ---------------------------------------------------------------------------

/**
 * One change the worker CONFIRMED (said Haan to) — what the profile build must honour after the
 * flush, when the transcript beside it still says the old value. Catalogue keys only: the final
 * values themselves are in the answer map and the draft, which the flush persists.
 */
export interface EditLedgerEntry {
  /** A pack `question_key`, or `skills` / `experience` for the draft's two lists. */
  readonly key: string;
  readonly op: ProfilingEditOp;
  /** The pack item's target field — what the profile build names it by; null for a list. */
  readonly targetField: string | null;
}

/** A session's ledger is bounded: a worker editing in a loop never grows the envelope without end. */
export const MAX_EDIT_LEDGER = 50;

const EditLedgerEntrySchema = z.object({
  key: z.string().min(1).max(64),
  op: z.enum(PROFILING_EDIT_OPS),
  targetField: z.string().min(1).max(64).nullable(),
});

/** Unreadable entries are dropped one by one; an unreadable ledger is empty (nothing confirmed). */
export function narrowEditLedger(value: unknown): EditLedgerEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: EditLedgerEntry[] = [];
  for (const raw of value) {
    const parsed = EditLedgerEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries.slice(-MAX_EDIT_LEDGER);
}

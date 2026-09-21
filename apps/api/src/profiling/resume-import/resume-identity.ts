import { parseAffirmation } from "@badabhai/profiling-lexicon";

import { descriptorForKind } from "../roles/role-registry";

/**
 * The "is this you?" turn — one Hinglish bubble over the staged summary line
 * (RI-identity).
 *
 * ── REVIEWED SERVER COPY, NOT GENERATED ──────────────────────────────────────
 *
 * Like `confirmPrompt` in `resume-confirm.ts`, this bubble is assembled from fixed
 * copy plus the worker's own staged values. A model asked to phrase it could phrase
 * it differently on a retry, for a turn whose whole purpose is that the worker
 * recognises what he wrote down. The only variable parts are the staged Hinglish
 * strings and the role's display name — all of them already worker-facing text.
 *
 * ── THIS REPLACES THE BATCH-CONFIRM WHILE IT EXISTS ──────────────────────────
 *
 * Owner ruling: while a staged identity line exists, the worker sees ONLY this
 * turn — the RI-5 batch-confirm ("Resume se ye mila … Sahi hai?") stays hidden.
 * Two back-to-back "is this your résumé?" bubbles would read as the app not
 * listening to its own answer. The orchestrator enforces the precedence; this
 * module only owns the words and the chips.
 */

/** What the chat turn renders, read off the staged import row. */
export interface IdentitySummary {
  readonly importId: string;
  /** The staged closed-set kind, or null when the model judged none. */
  readonly roleKind: string | null;
  readonly experienceText: string | null;
  readonly summaryText: string | null;
}

/**
 * The bubble. One sentence of what was read, then the question.
 *
 * APPROVED WORKER-FACING COPY (owner, 2026-09-19): "Resume se ye mila: [Role],
 * [tajurba]. [summary]. Kya ye aap hi hain?" Null parts are omitted, never
 * printed as "null" — a missing judgment reads as a shorter bubble, not as a
 * database token on the worker's screen.
 */
export function identityPrompt(summary: IdentitySummary): string {
  const seen = [roleDisplay(summary.roleKind), summary.experienceText].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  const head = seen.length > 0 ? `Resume se ye mila: ${seen.join(", ")}.` : "Resume se ye mila.";
  const body =
    typeof summary.summaryText === "string" && summary.summaryText.trim().length > 0
      ? ` ${summary.summaryText.trim()}`
      : "";
  return `${head}${body} Kya ye aap hi hain?`;
}

/**
 * The role id as the worker reads it — the registry's reviewed display name.
 *
 * `null` when the model judged none: the bubble then leads with tajurba/summary
 * rather than printing a kind id no worker would recognise.
 */
export function roleDisplay(kind: string | null): string | null {
  if (kind === null) return null;
  return descriptorForKind(kind)?.displayName ?? null;
}

/**
 * The two chips.
 *
 * CHIPS AND NOT A FREE ANSWER, for the same reason as the batch-confirm: the
 * question is genuinely binary and a tap is the cheapest thing a worker on a
 * mid-range Android between shifts can do. {@link readIdentityReply} still reads
 * typed and spoken replies — the chips are the affordance, not the contract.
 *
 * DISTINCT KEYS from `resume_confirm_yes/no`, deliberately: the two turns settle
 * different state (identity vs staged facts), and a tap replayed against the wrong
 * turn must not confirm something it never offered.
 */
export const RESUME_IDENTITY_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: "resume_identity_yes",
    label_text: "Haan, ye main hoon",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "resume_identity_no",
    label_text: "Nahi, ye main nahi hoon",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

export type IdentityReply = "accept" | "decline" | "unclear";

/**
 * What the worker's reply means.
 *
 * ONE LEXICON, NOT A SECOND ONE — same as `readConfirmReply`: `parseAffirmation`
 * is the parser the 236 boolean pack items use, resolving negation itself.
 *
 * `unclear` IS A REAL OUTCOME AND IS NOT AN ACCEPT. A reply this cannot read must
 * never be taken as "yes, that is me": that would attach a résumé to a worker on
 * the strength of a sentence nobody understood. The caller treats it as a decline
 * and the ordinary interview continues — the same fail-closed posture as the
 * batch-confirm.
 */
export function readIdentityReply(text: string): IdentityReply {
  const chip = RESUME_IDENTITY_OPTIONS.find((option) => option.option_key === text.trim());
  if (chip) return chip.value ? "accept" : "decline";

  const parsed = parseAffirmation(text);
  if (parsed === null) return "unclear";
  return parsed.value ? "accept" : "decline";
}

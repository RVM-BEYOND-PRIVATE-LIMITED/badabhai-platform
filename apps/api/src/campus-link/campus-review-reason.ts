/**
 * #2746 PR 5 — the placement team's note on a review decision, made safe to store and to show.
 *
 * The note is shown VERBATIM to the company (`rvm_review.reason` on its posting reads), so before
 * it is stored every character a reader cannot see is removed: control characters (`\p{Cc}`)
 * except the newline, which a multi-line note needs, and invisible format characters (`\p{Cf}`:
 * bidi overrides and isolates, zero-width spaces and joiners, the BOM). A bidi override in
 * particular can make the company read a note different from the one stored (security review of
 * #2746 PR 4). What is left is trimmed; a note that was only such characters is no note at all.
 *
 * Applied after the contract's zod parse (`CampusReviewBodySchema.reason`: trimmed, 1 to 500), so
 * the result is at most 500 characters and fits `jpir_reason_chk`. The contract is not changed:
 * this is how BadaBhai stores a valid note, not a new rule on what Campus may send.
 */

/** Every control and format character; the newline is put back by the replacer. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** Spelled by code point so no editor or tool can turn it into something else. */
const NEWLINE = String.fromCharCode(0x0a);

/** The note as BadaBhai stores it, or `undefined` when nothing visible is left. */
export function cleanReviewReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(HIDDEN_CHARACTERS, (ch) => (ch === NEWLINE ? ch : "")).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

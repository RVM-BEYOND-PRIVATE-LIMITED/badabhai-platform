import { isDroppedFromNote } from "./campus-characters";

/**
 * #2746 PR 5 — the placement team's note on a review decision, made safe to store and to show.
 *
 * The note is shown VERBATIM to the company (`rvm_review.reason` on its posting reads), so before
 * it is stored every character a reader cannot see, or that the driver would rewrite, is removed
 * (`isDroppedFromNote`, `./campus-characters`):
 *   - control characters (`\p{Cc}`) except the newline, which a multi-line note needs;
 *   - invisible format characters (`\p{Cf}`: bidi overrides and isolates, zero-width spaces, the
 *     BOM), EXCEPT ZWNJ and ZWJ, which Indic spellings need. A bidi override can make the company
 *     read a note other than the one stored (security review of #2746 PR 4);
 *   - line and paragraph separators (`\p{Zl}`, `\p{Zp}`), which break a line where no newline is;
 *   - private-use (`\p{Co}`) and unassigned (`\p{Cn}`) code points, which render as nothing or as
 *     anything;
 *   - lone surrogates (`\p{Cs}`), which the driver rewrites to U+FFFD.
 * What is left is trimmed; a note that was only such characters is no note at all.
 *
 * Applied after the contract's zod parse (`CampusReviewBodySchema.reason`: trimmed, 1 to 500), so
 * the result is at most 500 characters and fits `jpir_reason_chk`. The contract is not changed:
 * this is how BadaBhai stores a valid note, not a new rule on what Campus may send.
 */
export function cleanReviewReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let kept = "";
  for (const ch of raw) {
    if (!isDroppedFromNote(ch)) kept += ch;
  }
  const cleaned = kept.trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

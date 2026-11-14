import { isDroppedFromNote } from "../campus-link/campus-characters";

/**
 * #2746 PR 6 — THE CONTACT NAME, made safe to store and to show (to RVM's placement team).
 *
 * The multi-line texts of a drive request (the company's `roles_note`, the placement team's
 * decision `reason`) use #2746 PR 5's note cleaner, `cleanReviewReason`. A name is one line, so
 * on top of the same character rule (`isDroppedFromNote`, `campus-link/campus-characters.ts`) a
 * tab or a line break becomes a space, and "Ravi<LF>Sharma" is stored as "Ravi Sharma":
 *   - control characters (`\p{Cc}`), lone surrogates (`\p{Cs}`), private-use (`\p{Co}`) and
 *     unassigned (`\p{Cn}`) code points, and line and paragraph separators (`\p{Zl}`, `\p{Zp}`)
 *     are removed;
 *   - format characters (`\p{Cf}`: bidi overrides, zero-width space, the BOM) are removed EXCEPT
 *     ZWNJ and ZWJ, which Indic spellings of a name need.
 * What is left is trimmed; a name of nothing else is no name (the service refuses it).
 */

/** Spelled by code point so no editor or tool can turn them into something else. */
const LINE_BREAKS: ReadonlySet<string> = new Set([
  String.fromCharCode(0x09),
  String.fromCharCode(0x0a),
  String.fromCharCode(0x0d),
]);
const SPACE = String.fromCharCode(0x20);

/** The contact name as BadaBhai stores it, or `undefined` when nothing visible is left. */
export function cleanDriveLine(raw: string): string | undefined {
  let kept = "";
  for (const ch of raw) {
    if (LINE_BREAKS.has(ch)) kept += SPACE;
    else if (!isDroppedFromNote(ch)) kept += ch;
  }
  const cleaned = kept.trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

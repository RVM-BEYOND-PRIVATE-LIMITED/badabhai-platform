import { hasVisibleCharacter, isDroppedFromNote } from "../campus-link/campus-characters";

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
 * What is left is trimmed; a name with no VISIBLE character left (only spaces or ZWNJ / ZWJ, PR 5's
 * `hasVisibleCharacter`, the rule a Campus label follows) is no name (the service refuses it).
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
  return hasVisibleCharacter(cleaned) ? cleaned : undefined;
}

const DECIMAL_DIGIT = /\p{Nd}/u;
const COMBINING_MARK = /\p{M}/u;
/**
 * The ASCII digit a decimal digit (`\p{Nd}`) stands for. Unicode keeps every script's digits as a
 * contiguous run of ten in order (0 to 9), and a run of several such tens stays aligned, so the
 * value is the offset from the start of the run, modulo ten.
 */
function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  let start = cp;
  while (start > 0 && cp - start < 200 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) {
    start -= 1;
  }
  return String((cp - start) % 10);
}

/**
 * SECURITY REVIEW M1, N1-N3 (#2746 PR 6) — the copy of a `roles_note` the hard-identifier screen
 * reads IN ADDITION to the note itself (the service screens both, and either refuses). NEVER
 * STORED: the note is stored as cleaned (`cleanReviewReason`), and this copy is only screened.
 *
 * The shared detector (`common/hard-identifier.ts`, unchanged here) reads ASCII digits and `@`, so
 * a phone in Devanagari or full-width digits, one with a combining mark after each digit, and an
 * email with a full-width at sign (U+FF20) all passed. The copy closes those:
 *   1. NFKC: full-width digits and letters become ASCII, the full-width at sign becomes `@`;
 *   2. every decimal digit of any script (`p{Nd}`) becomes its ASCII digit;
 *   3. combining marks (`p{M}`) are dropped.
 * ZWJ / ZWNJ, which the note keeps, are stripped by the detector itself before it matches.
 *
 * NOT A SEPARATOR: `/` and `\` (owner decision, security re-check N2/N3). Reading them as a space
 * refused ordinary drive text (`2024/2025/2026 pass-outs` as an Aadhaar, `12000/18000`,
 * `12/11/2026 - 15/11/2026`, `VMC 850/1060/1260` and `411057/411018` as phones), and a copy alone
 * lost the detector's match on an ID written with `/` (`A/c no 12345678`, `Reg No: MH/2019/1234`),
 * which is why the note itself is screened too. The known gap, a phone split by `/`, `\`, U+2215, U+2044,
 * `:`, `~`, `*`, `+`, `=` or U+30FB, is risk R86; the shared fix is #2812.
 */
export function screeningCopyOf(note: string): string {
  let out = "";
  for (const ch of note.normalize("NFKC")) {
    if (COMBINING_MARK.test(ch)) continue;
    out += DECIMAL_DIGIT.test(ch) ? asciiDigit(ch) : ch;
  }
  return out;
}

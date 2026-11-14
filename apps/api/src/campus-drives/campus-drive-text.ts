/**
 * #2746 PR 6 — FREE TEXT ON A CAMPUS-DRIVE REQUEST, made safe to store and to show.
 *
 * Three fields are typed by one party and read by another: the company's `roles_note` (read by
 * RVM's placement team in Campus), the contact person's name (read by the placement team) and the
 * placement team's decision `reason` (shown to the company as written). Before any of them is
 * stored, every character a reader cannot see, or that the driver would rewrite, is removed:
 *   - control characters (`\p{Cc}`) except the newline, which a multi-line note needs (a CR is
 *     dropped, so CRLF becomes LF);
 *   - invisible format characters (`\p{Cf}`: bidi overrides and isolates, zero-width spaces and
 *     joiners, the BOM). A bidi override can make the reader see text other than what is stored
 *     (security review of #2746 PR 4);
 *   - line and paragraph separators (`\p{Zl}`, `\p{Zp}`), which break a line where no newline is;
 *   - private-use (`\p{Co}`) and unassigned (`\p{Cn}`) code points, which render as nothing or as
 *     anything (the set PR 5's review-reason cleaner uses);
 *   - lone surrogates (`\p{Cs}`), which the driver rewrites to U+FFFD.
 * What is left is trimmed; a value that was only such characters is no value at all.
 *
 * Applied AFTER the zod parse (trimmed, length-capped), so the result is never longer than the cap
 * and fits the table's `char_length` CHECKs. A name may not hold a newline: it is one line.
 */

/** Every character the text may not keep; the newline is put back by the replacer. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/gu;

/** Spelled by code point so no editor or tool can turn them into something else. */
const TAB = String.fromCharCode(0x09);
const NEWLINE = String.fromCharCode(0x0a);
const CARRIAGE_RETURN = String.fromCharCode(0x0d);

/** Multi-line text (`roles_note`, `reason`) as BadaBhai stores it, or `undefined` when empty. */
export function cleanDriveText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(HIDDEN_CHARACTERS, (ch) => (ch === NEWLINE ? ch : "")).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * One-line text (the contact name): a tab or a line break becomes a space, every other hidden
 * character is removed, so "Ravi<LF>Sharma" is stored as "Ravi Sharma".
 */
export function cleanDriveLine(raw: string): string | undefined {
  const cleaned = raw
    .replace(HIDDEN_CHARACTERS, (ch) =>
      ch === TAB || ch === NEWLINE || ch === CARRIAGE_RETURN ? " " : "",
    )
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

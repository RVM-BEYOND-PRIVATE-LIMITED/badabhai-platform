/**
 * #2746 PR 5 — WHICH CHARACTERS A CAMPUS ID, LABEL OR NOTE MAY HOLD. One home, so the contract
 * (`CourseIdSchema`, the targeting labels) and the review-note cleaner cannot drift apart.
 *
 * Every special character is spelled by its code point (`String.fromCharCode`), never typed: an
 * editor or a tool can silently turn a typed escape into the raw character.
 *
 * Refused everywhere: control (`Cc`), lone surrogates (`Cs`, which the driver rewrites to U+FFFD,
 * collapsing two distinct ids into one key), private use (`Co`), unassigned (`Cn`), line and
 * paragraph separators (`Zl`, `Zp`), and format characters (`Cf`: bidi overrides and isolates,
 * zero-width space, BOM) with ONE exception for text: ZWNJ (U+200C) and ZWJ (U+200D), which Indic
 * spellings need, are kept in labels and notes.
 */

/** The general categories every Campus text refuses (format is handled per kind below). */
const ALWAYS_FORBIDDEN = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const FORMAT = /\p{Cf}/u;
const SEPARATOR = /\p{Z}/u;
const WHITESPACE = /\s/u;

const SPACE = String.fromCharCode(0x20);
const NEWLINE = String.fromCharCode(0x0a);
/** Zero-width non-joiner and joiner: format characters Indic scripts need inside words. */
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);
const INDIC_JOINERS: ReadonlySet<string> = new Set([ZWNJ, ZWJ]);

/**
 * A course id (and any id Campus sends as text) may not hold a hidden or separator character. The
 * ONE separator allowed is the plain ASCII space (U+0020) inside the id, because the Scheduler's id
 * format is not confirmed; the schema trims the ends. No format character at all, joiners
 * included: an id is matched, not read.
 */
export function hasForbiddenIdCharacter(id: string): boolean {
  for (const ch of id) {
    if (ch === SPACE) continue;
    if (ALWAYS_FORBIDDEN.test(ch) || FORMAT.test(ch) || SEPARATOR.test(ch)) return true;
  }
  return false;
}

/**
 * A label companies read. Spaces of every kind are allowed (they are visible); a format character
 * only when it is ZWNJ or ZWJ.
 */
export function hasForbiddenLabelCharacter(label: string): boolean {
  for (const ch of label) {
    if (ALWAYS_FORBIDDEN.test(ch)) return true;
    if (FORMAT.test(ch) && !INDIC_JOINERS.has(ch)) return true;
  }
  return false;
}

/**
 * Whether `text` shows anything: at least one character that is not a separator, whitespace or a
 * joiner. A label of joiners and spaces only passes the character rules yet renders blank, so a
 * label must have one (security re-check L3), and a note without one is no note.
 */
export function hasVisibleCharacter(text: string): boolean {
  for (const ch of text) {
    // Separators and whitespace show nothing, and neither does a control or format character: the
    // ZWNJ / ZWJ joiners are format (`Cf`) characters, so they never count as visible.
    if (SEPARATOR.test(ch) || WHITESPACE.test(ch)) continue;
    if (ALWAYS_FORBIDDEN.test(ch) || FORMAT.test(ch)) continue;
    return true;
  }
  return false;
}

/**
 * Whether the review-note cleaner drops `ch`: the label rule, plus the newline kept (a note may be
 * several lines; it is the only control character kept).
 */
export function isDroppedFromNote(ch: string): boolean {
  if (ch === NEWLINE) return false;
  if (ALWAYS_FORBIDDEN.test(ch)) return true;
  return FORMAT.test(ch) && !INDIC_JOINERS.has(ch);
}

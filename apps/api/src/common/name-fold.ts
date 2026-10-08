/**
 * Reading a worker's stored name, and the text it is looked for in, THE SAME WAY (ADR-0047 G2,
 * #2166). Shared by the own-name redaction (`redact-known-name.ts`) and the free-chat probe's mask
 * (`free-chat-probe.mask.ts`, ADR-0051 §10).
 *
 * WHY A FOLD WITH A MAP, AND NOT A NORMALISED COPY OF THE TEXT. The redaction REWRITES the text a
 * model reads and a caller may persist, so it may change the name and nothing else: a fullwidth
 * digit, a "²" or a zero-width joiner elsewhere in the message must come out exactly as typed. The
 * text is therefore never normalised as a whole. It is cut into UNITS — one character with the
 * combining marks that follow it, or one invisible character — each unit is folded on its own, and
 * the folds are concatenated into a SHADOW that the name is matched in. Every shadow offset maps
 * back to the unit it came from, so a match in the shadow is a span of WHOLE units of the original,
 * and only that span is replaced.
 *
 * THE FOLD, UNIT BY UNIT:
 *   - An INVISIBLE (a format character or a default-ignorable code point: zero-width space and
 *     joiners, the soft hyphen, bidi controls, variation selectors, U+034F, the Hangul fillers)
 *     becomes ONE sentinel, {@link FOLD_SENTINEL}. The matcher lets a sentinel sit anywhere inside
 *     a typed name ("Sur<SHY>esh") and reads it as a word boundary ("main<ZWSP>Suresh") — which
 *     neither deleting the invisible nor spacing it can do on its own.
 *   - A LETTER gets NFKD: compatibility letters fold to their plain twins (fullwidth "Ｓ", math bold
 *     "𝐒", the "ﬁ" ligature), and a precomposed letter splits into base + marks, so "ज़" (U+095B)
 *     and "ज" + nukta read alike.
 *   - Anything else gets NFKD only when that adds no letter, digit or underscore (a fullwidth "．"
 *     becomes "."), and NFD otherwise — "™", "²" and "①" stay what they are, so a fold never moves
 *     a word boundary.
 *   - Two families of marks are FOLDED AWAY, because they are the ones a worker leaves off or adds:
 *     the Indic nuktas and the Latin combining diacritics (U+0300–U+036F). "ज़ाकिर" and "जाकिर",
 *     "José" and "Jose" read alike. Every other mark is KEPT: a vowel sign or a virama tells words
 *     apart, and folding them away would make "राम" read as "रम", and so match "रीमा" and "रोम".
 *
 * Decomposing unit by unit equals decomposing the whole text: a unit always starts at a character
 * that is not a combining mark, and canonical reordering never crosses one.
 *
 * LINEAR: one pass over the code points and one small `normalize` per non-ASCII unit. Pure ASCII text
 * is its own shadow, with no map at all.
 */

/**
 * Invisible characters: every format character (zero-width joiners, soft hyphen, bidi overrides) and
 * every default-ignorable code point (U+034F, variation selectors, the Hangul fillers U+115F, U+3164).
 * Global, for `replace`.
 */
export const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Where a stored name splits into parts: anything that is not a letter or a combining mark, AND every
 * modifier letter — `K.Suresh` → `K`, `Suresh`; `Ram-Prasad` → `Ram`, `Prasad`; `DʼSouza` (U+02BC,
 * a modifier letter) → `D`, `Souza`; `Raju007` → `Raju`. Global, so it serves `split` and `matchAll`
 * alike (both work on a copy and ignore `lastIndex`).
 */
export const NAME_SEPARATORS = /(?:[^\p{L}\p{M}]|\p{Lm})+/gu;

/**
 * What one invisible unit folds to. U+FFFF is a noncharacter, so no text should carry it; one that
 * does is read as an invisible too (see {@link IS_INVISIBLE}), so it can never mean anything else.
 */
export const FOLD_SENTINEL = "\uFFFF";

const IS_INVISIBLE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}\uFFFF]$/u;
const INVISIBLE_OR_SENTINEL = /[\p{Cf}\p{Default_Ignorable_Code_Point}\uFFFF]/gu;
const IS_MARK = /^\p{M}$/u;
const STARTS_WITH_LETTER = /^\p{L}/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/**
 * The marks folded away: the Latin combining diacritics, and the nukta of Devanagari, Bengali,
 * Gurmukhi, Gujarati, Oriya, Telugu and Kannada.
 */
const FOLDED_AWAY_MARKS = /[\u0300-\u036F\u093C\u09BC\u0A3C\u0ABC\u0B3C\u0C3C\u0CBC]/gu;

/** Text folded for name matching, with the way back to the original. */
export interface FoldedText {
  readonly shadow: string;
  /**
   * The UTF-16 span of the ORIGINAL text that shadow offsets `[start, end)` were folded from —
   * widened to whole units, so a replacement never splits a letter from its marks. `end > start`.
   */
  originalSpan(start: number, end: number): readonly [number, number];
}

/** `text` folded for matching a name in it (see the module header). */
export function foldText(text: string): FoldedText {
  if (isAscii(text)) return { shadow: text, originalSpan: (start, end) => [start, end] };
  const { shadow, unitStarts, shadowStarts } = fold(text, true);
  const unitAt = (offset: number): number => {
    // The last unit whose fold starts at or before `offset`. A unit that folded to nothing shares
    // its start with the next one, so the last of them is the one that holds `offset`.
    let low = 0;
    let high = shadowStarts.length - 2;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((shadowStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  return {
    shadow,
    originalSpan: (start, end) => [
      unitStarts[unitAt(start)] ?? 0,
      unitStarts[unitAt(end - 1) + 1] ?? text.length,
    ],
  };
}

/**
 * A stored name folded as {@link foldText} folds the text, with two differences: its invisibles are
 * DELETED rather than kept as sentinels (a soft hyphen in a stored "Sur<SHY>esh" is a typo inside one
 * word), and its marks are all KEPT, so a part's length is counted as written. Fold the marks away
 * with {@link foldAwayMarks} before matching.
 */
export function foldName(name: string): string {
  return fold(name.replace(INVISIBLE_OR_SENTINEL, ""), false).shadow;
}

/** `value` without the marks {@link foldText} folds away (the nuktas, the Latin diacritics). */
export function foldAwayMarks(value: string): string {
  return value.replace(FOLDED_AWAY_MARKS, "");
}

/** One part of a whitespace-delimited word of a stored name, and the separator run before it. */
export interface NameWordPart {
  readonly part: string;
  /** The separator run between this part and the previous one in the word; "" for the first. */
  readonly separatorBefore: string;
}

/** The parts of one word of a stored name, split on {@link NAME_SEPARATORS}. */
export function nameWordParts(word: string): NameWordPart[] {
  const parts: NameWordPart[] = [];
  let cursor = 0;
  let separator = "";
  for (const run of word.matchAll(NAME_SEPARATORS)) {
    const part = word.slice(cursor, run.index);
    if (part.length > 0) parts.push({ part, separatorBefore: parts.length > 0 ? separator : "" });
    separator = part.length > 0 ? run[0] : separator + run[0];
    cursor = run.index + run[0].length;
  }
  const tail = word.slice(cursor);
  if (tail.length > 0) {
    parts.push({ part: tail, separatorBefore: parts.length > 0 ? separator : "" });
  }
  return parts;
}

function fold(
  text: string,
  stripMarks: boolean,
): { shadow: string; unitStarts: number[]; shadowStarts: number[] } {
  const unitStarts: number[] = [];
  const shadowStarts: number[] = [];
  let shadow = "";
  let open = -1; // where the unit that can still take marks starts; -1 when none is open
  const close = (end: number) => {
    if (open < 0) return;
    unitStarts.push(open);
    shadowStarts.push(shadow.length);
    shadow += foldUnit(text.slice(open, end), stripMarks);
    open = -1;
  };
  let offset = 0;
  for (const char of text) {
    if (IS_INVISIBLE.test(char)) {
      close(offset);
      unitStarts.push(offset);
      shadowStarts.push(shadow.length);
      shadow += FOLD_SENTINEL;
    } else if (open < 0 || !IS_MARK.test(char)) {
      close(offset);
      open = offset;
    }
    offset += char.length;
  }
  close(offset);
  unitStarts.push(offset);
  shadowStarts.push(shadow.length);
  return { shadow, unitStarts, shadowStarts };
}

function foldUnit(unit: string, stripMarks: boolean): string {
  if (unit.length === 1 && unit.charCodeAt(0) < 0x80) return unit;
  const compatible = unit.normalize("NFKD");
  const folded =
    STARTS_WITH_LETTER.test(unit) || !WORD_CHAR.test(compatible)
      ? compatible
      : unit.normalize("NFD");
  const visible = folded.replace(INVISIBLE_OR_SENTINEL, "");
  return stripMarks ? foldAwayMarks(visible) : visible;
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

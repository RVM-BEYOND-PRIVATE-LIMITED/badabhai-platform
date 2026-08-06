/**
 * Years of experience — a port of `signals._EXPERIENCE_RE` plus the spelled-out number table.
 *
 * Handles "7 saal", "saat saal", "7-8 years", "dedh saal". The compound forms are why the word
 * table is order-sensitive: "paune do" is 1.75 and "paune" alone is 0.75, so an alternation that
 * did not try the longer form first would read a worker's answer as a different number.
 */

import { compilePattern, experienceWords, loadLexicon, type PatternSpec } from "../internal/regex.js";
import { applyNegation } from "./negation.js";
import type { NormalizedValue } from "./types.js";

interface ExperienceFile {
  readonly matcher: PatternSpec;
}

const MATCHER = compilePattern(loadLexicon<ExperienceFile>("experience").matcher);

/** word -> value, built from the same ordered table the alternation is built from. */
const WORD_VALUES: ReadonlyMap<string, number> = new Map(
  experienceWords().map((e) => [e.word, e.value] as const),
);

/**
 * Digits, ASCII or Devanagari. The matcher accepts both (Python's `\d` did), so the parse has to
 * as well — otherwise a quantity that MATCHES would then fail to convert and be silently dropped.
 */
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

function toNumber(raw: string): number | null {
  const ascii = [...raw]
    .map((ch) => {
      const index = DEVANAGARI_DIGITS.indexOf(ch);
      return index >= 0 ? String(index) : ch;
    })
    .join("");
  const parsed = Number.parseFloat(ascii);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse years of experience from free text, or null.
 *
 * Returns the FIRST match, matching the Python detector's `search` semantics. A range like
 * "7-8 years" therefore yields 7 — the conservative end, and the same value the shipped
 * extractor produces today.
 */
export function parseExperienceYears(text: string): NormalizedValue<number> | null {
  const message = text || "";
  const match = MATCHER.exec(message);
  if (!match) return null;

  const quantity = match[1];
  if (quantity === undefined) return null;

  const value = WORD_VALUES.get(quantity.toLowerCase()) ?? toNumber(quantity);
  if (value === null) return null;

  const span = { start: match.index, end: match.index + match[0].length };
  const negated = applyNegation(message).spans.some(([s, e]) => s < span.end && span.start < e);
  return { value, span, negationVetoed: negated };
}

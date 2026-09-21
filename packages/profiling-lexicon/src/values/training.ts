/**
 * Training year — the `training_year` chat ask (qp_universal@4, Layer A elicitation).
 *
 * WHY A FOUR-DIGIT-YEAR PARSER AND NOT `answer_type: "number"`. The type layer has no numeric
 * parser by design (years and rupees share a type and share nothing else), so the field would
 * store a whole sentence. This reads the year the worker stated.
 *
 * THE BOUND IS THE DATABASE'S. `wt_year_chk` accepts 1950..2100, and a chat answer outside it
 * would fail the `worker_training` insert — the app-feel failure this programme exists to avoid.
 * A year the bound refuses returns null, so the question is re-asked rather than lost.
 *
 * TS-ONLY, DELIBERATELY — see `commute.ts` for the same reasoning: the answer map carries the
 * normalized value across the language boundary.
 */

import type { NormalizedValue } from "./types.js";

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

const YEAR = "(?:19[5-9][0-9]|20[0-9]{2}|2100)";
/** Digit-bounded so "20190" never yields "2019" and "12019" never yields a false year. */
const MATCHER = new RegExp(`(?:^|[^0-9०-९])(${YEAR})(?:[^0-9०-९]|$)`, "u");

function toAscii(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const index = DEVANAGARI_DIGITS.indexOf(ch);
    out += index >= 0 ? String(index) : ch;
  }
  return out;
}

/** The stated training year as a number, or null when the message states none in range. */
export function parseTrainingYear(text: string): NormalizedValue<number> | null {
  const ascii = toAscii(text || "");
  const match = MATCHER.exec(ascii);
  if (!match) return null;
  const year = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(year) || year < 1950 || year > 2100) return null;
  const start = match.index + match[0].indexOf(match[1]!);
  return {
    value: year,
    span: { start, end: start + match[1]!.length },
    negationVetoed: false,
  };
}

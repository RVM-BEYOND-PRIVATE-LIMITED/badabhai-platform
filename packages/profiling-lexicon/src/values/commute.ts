/**
 * Commute range in kilometres — the `commute_max_km` chat ask (qp_universal@4, Layer A
 * elicitation).
 *
 * WHY A NEW PARSER AND NOT `answer_type: "number"`. The type layer deliberately has no numeric
 * parser (`normalizeByAnswerType` falls a `number` item through to verbatim text) because two
 * number fields can mean completely different things. `commute_max_km` therefore needs the same
 * field-keyed normalizer every other typed field has, and this is it.
 *
 * WHY THE VALUE IS CLAMPED TO 1..500. The same bound `SetMyPreferencesSchema` enforces on the
 * page that owns the key. A chat answer of "2000 km" is a unit confusion or a typo, and storing it
 * would put an unmatchable number into `worker_attributes`; the question is simply re-asked.
 *
 * WHY RANGES RESOLVE TO THE UPPER END. "10 se 20 km" states a willingness of up to 20 — the
 * worker's own larger number, never a derived one. A range with no unit after the first number
 * ("10-20 km") behaves the same way because the scanner only accepts a complete quantity+unit
 * pair.
 *
 * TS-ONLY, DELIBERATELY. The Python side never re-reads a chat answer: `value_normalized` is
 * computed HERE at capture time and carried in the answer map, so a mirror detector would have no
 * runtime consumer. The shared parity corpus therefore does not carry this normalizer — the
 * cross-language contract for `commute_max_km` is the stored value, not a second parser.
 */

import type { NormalizedValue } from "./types.js";

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** `unitDays`-style word numbers, scoped to what a worker says about distance. */
const WORD_NUMBERS: Readonly<Record<string, number>> = {
  ek: 1,
  do: 2,
  teen: 3,
  tin: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  chhah: 6,
  che: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  dus: 10,
  gyarah: 11,
  barah: 12,
  pandrah: 15,
  bees: 20,
  pachees: 25,
  tees: 30,
  pachas: 50,
  sau: 100,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
};

/** The unit spellings a worker actually says. No `\b` — the shared-engine rule, applied here
 * even though this file is TS-only, so a future mirror can reuse the same source verbatim. */
const UNIT = "(?:kms?|kilometers?|kilometres?|किलोमीटर|कि\\.?मी\\.?)";

/**
 * One quantity token, then optional whitespace, then a km unit. The lookbehind refuses to start
 * mid-word (`adhas km` must not read as "das km") without a character class, which the linter
 * rightly flags when it spans Devanagari combining marks.
 */
const QUANTITY = "(?:[0-9]{1,3}|[०-९]{1,3}|[a-zA-Z]+)";
const MATCHER = new RegExp(`(?<![A-Za-z0-9])((${QUANTITY})\\s*${UNIT})`, "iu");

function toAscii(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const index = DEVANAGARI_DIGITS.indexOf(ch);
    out += index >= 0 ? String(index) : ch;
  }
  return out;
}

function toKilometres(token: string): number | null {
  const ascii = toAscii(token);
  if (/^[0-9]{1,3}$/.test(ascii)) return Number.parseInt(ascii, 10);
  const word = WORD_NUMBERS[ascii.toLowerCase()];
  return word ?? null;
}

/**
 * The stated maximum commute distance in kilometres, or null when the message states none.
 *
 * NEVER FABRICATES FROM SILENCE: "paas mein" (nearby) and "bahut door" state a sentiment, not a
 * distance, and both return null so the question stays askable.
 */
export function parseCommuteKm(text: string): NormalizedValue<number> | null {
  const match = MATCHER.exec(text || "");
  if (!match) return null;
  const km = toKilometres(match[2] ?? "");
  if (km === null || km < 1 || km > 500) return null;
  return {
    value: km,
    span: { start: match.index, end: match.index + match[0].length },
    // The caller (`answer-capture.ts`) runs the negation veto from the reported span; a detector
    // never pre-applies it here, matching every other normalizer in this package.
    negationVetoed: false,
  };
}

/**
 * What a worker typed into a number field → the number, or null when it is not one number.
 *
 * ═══ THE DEFECT THIS REPLACES (#1503) ═══
 *
 * `recordFor` used to read `Number(text.replace(/[^\d.-]/g, ""))`: delete everything that is not a
 * digit, then parse what is left. Every failure of that is silent and every one stores a FALSE
 * FACT rather than an error:
 *
 *   - "pata nahi"        → ""   → 0   an answered "zero years", when he said he does not know
 *   - "5 se 7 saal"      → "57" → 57  a range became fifty-seven years
 *   - "2 saal 6 mahine"  → "26" → 26  two and a half years became twenty-six
 *   - "6 saal nahi"      → "6"  → 6   a negation became the claim it negates
 *
 * ═══ SO IT ACCEPTS EXACTLY ONE NUMERIC TOKEN AND NOTHING ELSE ═══
 *
 * The whole trimmed text must be the number: plain digits, optionally a decimal part, optionally
 * grouped with commas the way an Indian ("1,00,000") or international ("100,000") worker writes
 * them, optionally led by a rupee sign. Any word, any second digit group, any unit suffix ("15k")
 * is not a number this function will guess at. Guessing is how the four rows above were written.
 *
 * WHAT THE CALLER DOES WITH null IS THE CALLER'S DECISION, deliberately: a trade question 400s so
 * the client can say "type a number", and the legacy-key shim declines, because a dead end on a
 * screen the app should no longer be showing is worse than an honest "not answered".
 */
const STRICT_NUMBER =
  /^₹?\s*(\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3}|\d+)(\.\d+)?$/u;

export function parseStrictNumber(text: string): number | null {
  const match = STRICT_NUMBER.exec(text.trim());
  if (!match) return null;
  const value = Number(`${match[1]!.replace(/,/g, "")}${match[2] ?? ""}`);
  return Number.isFinite(value) ? value : null;
}

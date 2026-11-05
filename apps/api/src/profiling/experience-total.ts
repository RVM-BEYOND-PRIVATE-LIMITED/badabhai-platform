/**
 * Total experience from a reply to "Is kaam mein aapko kitne saal ho gaye?" — in YEARS.
 *
 * WHY THIS FILE EXISTS. The shared reader (`parseExperienceYears`,
 * `@badabhai/profiling-lexicon`) reads a TOTAL in years with a "saal" unit only — "5 saal",
 * "paanch saal", "dedh saal". The question now shows a GENERAL keyboard, so the replies it
 * actually receives are broader: "2 saal 6 mahine", "8 mahine", "10 din", "3 years 2 months".
 * A months-only or days-only reply must not be dropped as "no answer" and re-asked twice.
 *
 * WHAT IT RETURNS. A finite number of YEARS, rounded to 2 decimals, or `null`:
 * - "5 saal" -> 5 (delegated to the shared reader, broad Hinglish table + Devanagari)
 * - "2 saal 6 mahine" -> 2.5 (shared years + months/12)
 * - "8 mahine" -> 0.67, "6 mahine" -> 0.5
 * - "10 din" -> 0.03 (days/365), "1 saal 10 din" -> 1.03
 * - fresher/bare-number replies ("fresher", "0", "5") -> null here; `readStatedTenureYears`
 *   owns those (called after this in `answer-capture.ts`), so this file never duplicates them.
 *
 * API-SIDE ONLY, deliberately (same precedent as `duration-months.ts`): the lexicon matcher is
 * shared with the ai-service (`signals.py`) and stays byte-identical. Months/days are read here,
 * next to the question that asked for them.
 *
 * PURE. No I/O, no pack, no envelope — a string in, years+span or `null` out.
 */

import { parseExperienceYears } from "@badabhai/profiling-lexicon";

export interface ExperienceTotal {
  readonly value: number;
  readonly span: { start: number; end: number };
}

const MONTH_UNITS: ReadonlySet<string> = new Set([
  "mahine",
  "mahina",
  "mahino",
  "maheena",
  "maheene",
  "mahinon",
  "month",
  "months",
  "महीने",
  "महीना",
  "महीनों",
]);

const DAY_UNITS: ReadonlySet<string> = new Set([
  "din",
  "dino",
  "dinon",
  "day",
  "days",
  "दिन",
  "दिनों",
]);

/** Spelled-out quantities beside a month/day unit. Same everyday words workers use for years. */
const WORD_VALUES: ReadonlyMap<string, number> = new Map([
  ["ek", 1],
  ["do", 2],
  ["teen", 3],
  ["tin", 3],
  ["char", 4],
  ["chaar", 4],
  ["panch", 5],
  ["paanch", 5],
  ["chhe", 6],
  ["chhah", 6],
  ["saat", 7],
  ["aath", 8],
  ["aathh", 8],
  ["nau", 9],
  ["das", 10],
  ["gyarah", 11],
  ["barah", 12],
  ["dedh", 1.5],
  ["dhai", 2.5],
  ["dhaai", 2.5],
  ["adhai", 2.5],
  ["aadha", 0.5],
  ["adha", 0.5],
]);

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

function numberValue(token: string): number | null {
  const word = WORD_VALUES.get(token.toLowerCase());
  if (word !== undefined) return word;
  const ascii = [...token]
    .map((ch) => {
      const index = DEVANAGARI_DIGITS.indexOf(ch);
      return index >= 0 ? String(index) : ch;
    })
    .join("");
  const parsed = Number.parseFloat(ascii);
  return Number.isFinite(parsed) ? parsed : null;
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{L}\p{M}\p{N}.]+/gu;
  for (const match of text.matchAll(pattern)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

interface Quantity {
  readonly years: number;
  readonly start: number;
  readonly end: number;
}

function findQuantities(
  tokens: readonly Token[],
  units: ReadonlySet<string>,
  perUnitYears: number,
): Quantity[] {
  const found: Quantity[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const numberToken = tokens[i] as Token;
    const unitToken = tokens[i + 1] as Token;
    if (!units.has(unitToken.text.toLowerCase())) continue;
    const value = numberValue(numberToken.text);
    if (value === null) continue;
    found.push({ years: value * perUnitYears, start: numberToken.start, end: unitToken.end });
  }
  return found;
}

/**
 * Parse total experience in years from free text, or `null` when no years/months/days figure.
 *
 * The shared years reader owns the "saal" figure (broad table, decimals, Devanagari); this adds
 * the months and days components the shared reader deliberately excludes. Either side alone
 * resolves ("8 mahine", "paanch saal"); together they sum ("2 saal 6 mahine" -> 2.5).
 */
export function parseExperienceTotal(text: string): ExperienceTotal | null {
  const message = text || "";
  const yearsReading = parseExperienceYears(message);
  const tokens = tokenize(message);
  const months = findQuantities(tokens, MONTH_UNITS, 1 / 12);
  const days = findQuantities(tokens, DAY_UNITS, 1 / 365);
  if (!yearsReading && months.length === 0 && days.length === 0) return null;

  let total = yearsReading && !yearsReading.negationVetoed ? yearsReading.value : 0;
  let start = yearsReading ? yearsReading.span.start : Number.POSITIVE_INFINITY;
  let end = yearsReading ? yearsReading.span.end : Number.NEGATIVE_INFINITY;
  // A negated years span contributes nothing but still anchors the span for the veto below.
  if (yearsReading?.negationVetoed) total = 0;
  for (const q of [...months, ...days]) {
    total += q.years;
    if (q.start < start) start = q.start;
    if (q.end > end) end = q.end;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  return { value: Math.round(total * 100) / 100, span: { start, end } };
}

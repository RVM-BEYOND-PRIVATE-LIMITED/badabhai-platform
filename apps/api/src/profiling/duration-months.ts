/**
 * A single job's duration, in months — from free text a worker offers WHILE describing an
 * experience entry ("teen saal", "dedh saal", "8 mahine", "2 saal 6 mahine"). (#1505 F2)
 *
 * WHY THIS IS NOT `parseExperienceYears` (`@badabhai/profiling-lexicon`). That normalizer reads
 * the worker's TOTAL years of experience — one number, "saal" only, no months — and is the
 * correct reader for the universal pack's `experience_years` question. A per-job duration is a
 * different fact: it may be stated in months alone ("8 mahine"), and the model's own draft carries
 * `duration_months` already parsed on the ai-service side when it can. This is the API-SIDE
 * FALLBACK for the entries that arrive with `duration_months: null` — `duration_text` non-empty
 * but nothing numeric was pulled out of it there — so `settleFromLlmDraft` (`orchestrator.service.ts`)
 * has a second chance before it gives up and leaves `experience_years` for the pack question to
 * ask properly. API-SIDE ONLY, deliberately: no `apps/ai-service` change is needed or made here.
 *
 * PURE. No I/O, no pack, no envelope — a string in, a whole number of months or `null` out.
 *
 * VAGUE SPANS RETURN `null` RATHER THAN GUESS. "Kaafi saal" and "saal bhar" name no quantity —
 * `kaafi` and `bhar` are not numbers — so the pattern below, which requires a NUMBER immediately
 * before the unit, simply never matches them. That is the correct outcome for a sum a résumé's
 * total experience field is about to depend on (owner ruling, ADR §1505-1): an entry this
 * function cannot resolve must leave `experience_years` unsettled, not settle it on a guess.
 *
 * NEGATED SPANS RETURN `null` TOO — "3 saal nahi, 2 saal" must not resolve to 3. This reuses the
 * SAME negation engine every other capture path in this codebase reads through
 * (`@badabhai/profiling-lexicon`'s `applyNegation`), rather than a second implementation free to
 * disagree with the first about what "nahi" denies.
 */

import { applyNegation } from "@badabhai/profiling-lexicon";

/**
 * word -> years (before the *12 conversion below). Closed; extend by review.
 *
 * ONE THROUGH TEN (#1517 review, MINOR): the fractional/compound words (`dedh`/`dhai`/`sawa`) and
 * `ek`/`do` shipped with F2; `teen` through `das` were simply never added, so a worker who said
 * "teen saal" fell through to `numberValue`'s digit path, found no digits, and returned `null` —
 * INDISTINGUISHABLE, per this file's own docblock, from a deliberately vague span like "kaafi
 * saal". Since this is the API-side FALLBACK for exactly the case where the ai-service's own
 * `duration_months` is null, that silent `null` held the whole `experience_years` sum unsettled
 * (ruling-1) for a duration a worker stated in perfectly ordinary words.
 */
const YEAR_WORD_VALUES: ReadonlyMap<string, number> = new Map([
  ["ek", 1],
  ["do", 2],
  ["teen", 3],
  ["char", 4],
  ["panch", 5],
  ["chhe", 6],
  ["saat", 7],
  ["aath", 8],
  ["nau", 9],
  ["das", 10],
  ["dedh", 1.5],
  ["dhai", 2.5],
  ["sawa", 1.25],
]);

const YEAR_UNITS: ReadonlySet<string> = new Set([
  "saal",
  "saalon",
  "sal",
  "varsh",
  "varsho",
  "year",
  "years",
  "साल",
  "सालों",
  "वर्ष",
]);

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

/** Devanagari digits, in code-point order — the same table `parseExperienceYears` reads. */
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

function numberValue(token: string): number | null {
  const lower = token.toLowerCase();
  const word = YEAR_WORD_VALUES.get(lower);
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

/**
 * Split on runs of letters/digits (Unicode-aware) — never `\b`, which mishandles Devanagari.
 *
 * `\p{M}` (combining marks) MUST be in the class alongside `\p{L}`: a Devanagari matra like "ा"
 * (U+093E, "saal"'s own vowel sign) is category `Mn`, not `L`, and without it "साल" splits into
 * "स" + "ल" — two tokens, neither of which is in {@link YEAR_UNITS} — and every Devanagari-unit
 * duration silently fails to parse. Caught by `duration-months.test.ts`'s Devanagari-digit case,
 * which only exercises this because the unit word beside the digit is ALSO Devanagari.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{L}\p{M}\p{N}.]+/gu;
  for (const match of text.matchAll(pattern)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

interface Quantity {
  readonly months: number;
  readonly start: number;
  readonly end: number;
}

function findQuantities(tokens: readonly Token[], units: ReadonlySet<string>, perUnit: number): Quantity[] {
  const found: Quantity[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const numberToken = tokens[i] as Token;
    const unitToken = tokens[i + 1] as Token;
    if (!units.has(unitToken.text.toLowerCase())) continue;
    const value = numberValue(numberToken.text);
    if (value === null) continue;
    found.push({ months: value * perUnit, start: numberToken.start, end: unitToken.end });
  }
  return found;
}

/**
 * Parse a whole-number month count from free text describing ONE job's duration, or `null` when
 * nothing resolvable was said.
 *
 * SUMS A YEARS COMPONENT AND A MONTHS COMPONENT, because "2 saal 6 mahine" is one duration, not
 * two competing readings — the same shape the worker's own sentence has. Either component alone
 * ("8 mahine", "teen saal") resolves on its own.
 *
 * ROUNDED, never truncated: a fractional word ("dedh saal" = 1.5 years = 18 months, already
 * whole) can still combine with a months component to leave a fraction of a month, which has no
 * meaning to round down and lose.
 */
export function parseDurationMonths(text: string): number | null {
  const message = text || "";
  const tokens = tokenize(message);
  const years = findQuantities(tokens, YEAR_UNITS, 12);
  const months = findQuantities(tokens, MONTH_UNITS, 1);
  const quantities = [...years, ...months];
  if (quantities.length === 0) return null;

  const negation = applyNegation(message);
  const anyNegated = quantities.some((q) =>
    negation.spans.some(([s, e]) => s < q.end && q.start < e),
  );
  if (anyNegated) return null;

  const total = quantities.reduce((sum, q) => sum + q.months, 0);
  return Math.round(total);
}

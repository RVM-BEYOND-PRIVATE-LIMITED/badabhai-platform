/**
 * Salary normalization — a faithful port of `signals._detect_salary` and its four helpers
 * (`_parse_amount`, `_looks_like_a_year`, `_period_months`, `_CREDENTIAL_BEFORE_RE`).
 *
 * THE REASON THIS FILE IS SEPARATE FROM THE OTHER NORMALIZERS: the period decides a factor of
 * TWELVE. "2.5 lakh saal ka" is ₹20,833/month; read as monthly it becomes ₹2,50,000 and lands in
 * `salary_expectation.amount_min`, on the resume, and in the deterministic ranking factor that
 * `reach.mappers.ts` reads — the single field employers filter on hardest. Every window width and
 * cue list lives in `data/salary.json` and was tuned against a measured regression.
 *
 * THE RULE THE WHOLE FILE OBEYS: prefer NO number over a WRONG number. An ambiguous period, an
 * implausible magnitude, a bare calendar year or a credential id all record nothing. An
 * unrecorded salary is re-askable next turn; a fabricated one ships.
 *
 * OFFSETS. Like the negation engine, this indexes by UTF-16 code unit where Python indexes by
 * code point. They agree for Latin and Devanagari (both BMP, no surrogate pairs).
 *
 * A SHIPPED HAZARD, PRESERVED DELIBERATELY: the windows are cut from `text.toLowerCase()` using
 * offsets measured against `text`. For any character whose lowercase form has a different length
 * the two desynchronize. That is true of the Python this ports, character for character, and no
 * such character occurs in Hinglish or Devanagari — Devanagari is caseless. Changing it would be
 * a behaviour change, not a port, so it is documented rather than silently corrected.
 */

import { compilePattern, loadLexicon, type PatternSpec } from "../internal/regex.js";
import { applyNegation } from "./negation.js";
import type { MonthlyInr, NormalizedValue } from "./types.js";

interface SalaryFile {
  readonly matcher: PatternSpec;
  readonly thousandUnits: readonly string[];
  readonly lakhUnits: readonly string[];
  readonly minDigitsWithoutUnit: number;
  readonly minAmountInr: number;
  readonly maxPlausibleInr: number;
  readonly yearMin: number;
  readonly yearMax: number;
  readonly periodWindowBefore: number;
  readonly periodWindowAfter: number;
  readonly expectedWindowBefore: number;
  readonly expectedWindowAfter: number;
  readonly expectedCues: readonly string[];
  readonly clauseTerminator: PatternSpec;
  readonly annualCuesAfter: readonly PatternSpec[];
  readonly annualCuesBefore: readonly PatternSpec[];
  readonly monthlyCues: readonly PatternSpec[];
  readonly moneyCues: readonly PatternSpec[];
  readonly credentialBefore: PatternSpec;
}

const SALARY = loadLexicon<SalaryFile>("salary");

const MATCHER = compilePattern(SALARY.matcher);
const CREDENTIAL_BEFORE = compilePattern(SALARY.credentialBefore);

// Arrow, not a bare `specs.map(compilePattern)`: `map` passes the INDEX as the second argument,
// which `compilePattern` now reads as its fragments map. Caught by the typechecker.
const compileAll = (specs: readonly PatternSpec[]): readonly RegExp[] =>
  specs.map((spec) => compilePattern(spec));

const ANNUAL_AFTER = compileAll(SALARY.annualCuesAfter);
const ANNUAL_BEFORE = compileAll(SALARY.annualCuesBefore);
const MONTHLY = compileAll(SALARY.monthlyCues);
const MONEY = compileAll(SALARY.moneyCues);

const THOUSAND_UNITS = new Set(SALARY.thousandUnits);
const LAKH_UNITS = new Set(SALARY.lakhUnits);

// Guard (b) of the period-anchored extension. Includes the Devanagari danda, which ends a
// sentence without being a word character — shared through the lexicon so both engines stop at
// the same set rather than at whatever each language's punctuation class happens to hold.
const CLAUSE_TERMINATOR = compilePattern(SALARY.clauseTerminator);

/**
 * A fresh global+hasIndices matcher per call.
 *
 * `d` is needed because the port's spans and its line clamp are anchored on the DIGITS (group 1),
 * not on the whole match — the match spans surrounding whitespace at both ends, so its own start
 * can sit on the neighbouring line and would pick the wrong line entirely.
 *
 * Built per call rather than shared: a global RegExp carries `lastIndex`, and a shared one would
 * make this function's result depend on who called it last.
 */
function matcher(): RegExp {
  return new RegExp(MATCHER.source, `${MATCHER.flags}gd`);
}

/** Digits, ASCII or Devanagari — the only characters the matcher's group 1 can contain. */
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

function toAscii(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const index = DEVANAGARI_DIGITS.indexOf(ch);
    out += index >= 0 ? String(index) : ch;
  }
  return out;
}

/**
 * Python's `str.isdigit()` over the characters this matcher can actually produce.
 *
 * The real `isdigit()` is true for far more than these (superscripts, other Indic scripts), but
 * group 1 is `[0-9०-९]` with commas already stripped, so the two agree on every input that can
 * reach here. Narrowing to what the pattern admits is what keeps the engines in step.
 */
function isAllDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const ch of value) {
    if (!((ch >= "0" && ch <= "9") || DEVANAGARI_DIGITS.includes(ch))) return false;
  }
  return true;
}

/**
 * Parse an amount to a MONTHLY rupee figure. `signals._parse_amount`.
 *
 * `months` is the period the stated amount covers (1 = monthly, 12 = annual), so an annual figure
 * is divided down instead of being stored as a monthly one. The plausibility ceiling is applied to
 * the MONTHLY result, which is what the field actually means.
 */
export function parseAmount(num: string, unit: string | null, months = 1): MonthlyInr | null {
  const parsed = Number.parseFloat(toAscii(num.replace(/,/g, "")));
  if (!Number.isFinite(parsed)) return null;

  let value = parsed;
  const lowerUnit = (unit ?? "").toLowerCase();
  if (THOUSAND_UNITS.has(lowerUnit)) value *= 1_000;
  else if (LAKH_UNITS.has(lowerUnit)) value *= 100_000;
  if (months > 1) value /= months;

  if (value <= 0 || value > SALARY.maxPlausibleInr) return null;
  return Math.trunc(value);
}

/**
 * "2012 se kaam kar raha hu" is a START YEAR, not a salary. `signals._looks_like_a_year`.
 *
 * A bare 4-digit number in the calendar range is only accepted as money when the text right around
 * it actually says money. Otherwise it is dropped — an unrecorded salary is re-askable, a
 * fabricated ₹2,012 salary ships onto the resume.
 */
function looksLikeAYear(num: string, unit: string | null, near: string): boolean {
  if (unit) return false; // "2012 k" / "2012 lakh" is not a year
  const digits = num.replace(/,/g, "");
  if (digits.length !== 4 || !isAllDigits(digits)) return false;
  const asNumber = Number.parseInt(toAscii(digits), 10);
  if (!(asNumber >= SALARY.yearMin && asNumber <= SALARY.yearMax)) return false;
  return !MONEY.some((cue) => cue.test(near));
}

/**
 * How many months the amount covers: 1 (monthly, the default), 12 (annual), or null when the cues
 * CONFLICT. `signals._period_months`.
 *
 * Ambiguous — both an annual and a monthly cue — records nothing, per "prefer no number over a
 * wrong number".
 */
function periodMonths(nearBefore: string, nearAfter: string): number | null {
  const annual =
    ANNUAL_AFTER.some((cue) => cue.test(nearAfter)) ||
    ANNUAL_BEFORE.some((cue) => cue.test(nearBefore));
  const monthly = MONTHLY.some((cue) => cue.test(nearBefore) || cue.test(nearAfter));
  if (annual && monthly) return null;
  return annual ? 12 : 1;
}

/**
 * The two salary slots one message can fill.
 *
 * Both are returned because one message routinely fills both — "abhi 25000 milta hai, 35000
 * chahiye" is a worker answering the current-pay and expected-pay questions in one breath, and
 * collapsing that to a single number throws away the half the orchestrator did not ask for.
 */
export interface SalaryReading {
  /** Pay the worker is ASKING for — an `_EXPECTED_CUES` hit near the amount. */
  readonly expected: NormalizedValue<MonthlyInr> | null;
  /** Pay the worker is receiving TODAY — any amount with no expectation cue near it. */
  readonly current: NormalizedValue<MonthlyInr> | null;
}

/**
 * Every salary in one message, split into the expected and current slots.
 *
 * FIRST WRITER WINS in each slot, exactly as `_detect_salary` does: a second expected amount does
 * not overwrite the first. Correction handling is the orchestrator's job (`_may_commit` and
 * `AnswerRecord.history`), not this function's — a normalizer that silently preferred the last
 * number would make a correction indistinguishable from a worker listing two figures.
 */
/**
 * Offset just past the FIRST period word following an amount, or null. `_period_phrase_end`.
 *
 * First by END, not by start: "har mahine" and "mahine" can match at the same place and the
 * shorter one must not truncate the anchor.
 */
function periodPhraseEnd(nearAfter: string): number | null {
  let best: number | null = null;
  for (const cue of [...ANNUAL_AFTER, ...MONTHLY]) {
    const found = cue.exec(nearAfter);
    if (found !== null && (best === null || found.index + found[0].length < best)) {
      best = found.index + found[0].length;
    }
  }
  return best;
}

/**
 * Is there an expectation cue just past this amount's PERIOD phrase? `_cue_after_the_period_phrase`.
 *
 * "35000 mahina chahiye" is an asking price, and the shipped ten-character window never sees the
 * cue because " mahina" spends eight of the ten — so the figure lands in the CURRENT slot and a
 * worker's asking price is printed as what he already earns. Re-anchoring the window's end after
 * the period phrase is the same width from a different origin; on its own it re-creates the
 * cross-amount regression the line clamp exists to prevent, 1,776 times in a 7,150-utterance
 * sweep. The three guards below take that to zero, and `data/salary.json` carries each one's
 * measured contribution.
 */
function cueAfterThePeriodPhrase(
  lower: string,
  matchEnd: number,
  numbers: readonly number[],
  windowStart: number,
  baseEnd: number,
  lineEnd: number,
): boolean {
  const nearAfter = lower.slice(matchEnd, Math.min(lineEnd, matchEnd + SALARY.periodWindowAfter));
  const phraseEnd = periodPhraseEnd(nearAfter);
  if (phraseEnd === null) return false;

  const anchored = matchEnd + phraseEnd;
  let limit = Math.min(lineEnd, anchored + SALARY.expectedWindowAfter);

  const nextNumber = numbers.find((start) => start >= matchEnd);
  if (nextNumber !== undefined) limit = Math.min(limit, nextNumber); // (a)
  const terminator = CLAUSE_TERMINATOR.exec(lower.slice(anchored, limit));
  if (terminator !== null) limit = anchored + terminator.index; // (b)
  limit = Math.max(baseEnd, limit);

  const extension = lower.slice(windowStart, limit);
  for (const cue of SALARY.expectedCues) {
    // Only cues the BASE window could not already have seen — one inside it would have answered
    // this question before we were called.
    const at = extension.indexOf(cue, Math.max(0, baseEnd - windowStart - cue.length + 1));
    if (at === -1) continue;
    const cueEnd = windowStart + at + cue.length;
    // (c) — and ON THIS LINE, for the same reason every other window here is line-clamped.
    if (numbers.some((start) => start >= cueEnd && start < lineEnd)) continue;
    return true;
  }
  return false;
}

export function detectSalaries(text: string): SalaryReading {
  const message = text || "";
  const lower = message.toLowerCase();
  let expected: NormalizedValue<MonthlyInr> | null = null;
  let current: NormalizedValue<MonthlyInr> | null = null;

  // EVERY digit run the matcher can see, including ones rejected below as years, roll numbers
  // or bare two-digit counts. The guards ask "is another number standing here?", and a number
  // this pass declines to RECORD is still a number in the way.
  const numbers: number[] = [];
  for (const m of message.matchAll(matcher())) {
    const digitSpan = m.indices?.[1];
    if (digitSpan !== undefined) numbers.push(digitSpan[0]);
  }

  for (const m of message.matchAll(matcher())) {
    const indices = m.indices;
    const digitSpan = indices?.[1];
    const num = m[1];
    if (num === undefined || digitSpan === undefined) continue;
    const unit = m[2] ?? null;

    if (!unit && num.replace(/,/g, "").length < SALARY.minDigitsWithoutUnit) continue;

    // Every cue window is clamped to the LINE the number sits on. A cue on a neighbouring line is
    // a different utterance and says nothing about this number. Without the clamp two salary
    // answers on adjacent lines poison each other: "25000\n35000 chahiye" put " chah" inside
    // 25000's lookahead, so the CURRENT salary was recorded as EXPECTED and the real expected
    // salary was then dropped as a duplicate.
    const digitsAt = digitSpan[0];
    const lineStart = lower.lastIndexOf("\n", digitsAt - 1) + 1;
    const foundEnd = lower.indexOf("\n", digitsAt);
    const lineEnd = foundEnd === -1 ? lower.length : foundEnd;

    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;

    // Scoped to the text immediately BEFORE the number, never the whole line. Scanning the line
    // shipped a regression: a chat message is a single line, so "abhi 25000 milta hai, 35000
    // chahiye, NCVT certificate hai" had BOTH salaries dropped for a certificate mentioned later.
    if (CREDENTIAL_BEFORE.test(lower.slice(lineStart, digitsAt))) continue;

    const nearBefore = lower.slice(
      Math.max(lineStart, matchStart - SALARY.periodWindowBefore),
      matchStart,
    );
    const nearAfter = lower.slice(matchEnd, Math.min(lineEnd, matchEnd + SALARY.periodWindowAfter));

    if (looksLikeAYear(num, unit, `${nearBefore} ${nearAfter}`)) continue;

    const months = periodMonths(nearBefore, nearAfter);
    if (months === null) continue; // ambiguous period -> record nothing

    const amount = parseAmount(num, unit, months);
    if (amount === null || amount < SALARY.minAmountInr) continue;

    // The evidence span runs from the first digit to the end of the unit — never the whole match,
    // which includes the surrounding whitespace `\s*` consumed at both ends. The provenance gate
    // quotes this span back, so it has to be the number the worker actually typed.
    const unitSpan = indices?.[2];
    const span = { start: digitsAt, end: unitSpan ? unitSpan[1] : digitSpan[1] };
    const reading: NormalizedValue<MonthlyInr> = {
      value: amount,
      span,
      negationVetoed: applyNegation(message).spans.some(([s, e]) => s < span.end && span.start < e),
    };

    const windowStart = Math.max(lineStart, matchStart - SALARY.expectedWindowBefore);
    const baseEnd = Math.min(lineEnd, matchEnd + SALARY.expectedWindowAfter);
    const base = lower.slice(windowStart, baseEnd);
    const isExpected =
      SALARY.expectedCues.some((cue) => base.includes(cue)) ||
      cueAfterThePeriodPhrase(lower, matchEnd, numbers, windowStart, baseEnd, lineEnd);

    if (isExpected) {
      if (expected === null) expected = reading;
    } else if (current === null) {
      current = reading;
    }
  }

  return { expected, current };
}

/**
 * The single best monthly salary in a message, or null.
 *
 * Prefers the EXPECTED figure over the current one, because every question that reaches this
 * normalizer is asking what the worker wants — "abhi 25000 milta hai, 35000 chahiye" answers
 * `salary_expected` with 35000. Use {@link detectSalaries} when both slots matter.
 */
export function parseSalaryMonthly(text: string): NormalizedValue<MonthlyInr> | null {
  const { expected, current } = detectSalaries(text);
  return expected ?? current;
}

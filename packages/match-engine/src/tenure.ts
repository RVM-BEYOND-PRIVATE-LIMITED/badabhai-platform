/**
 * Matching V1 — industry tenure. Spec: `docs/specs/matching-algorithm-v1.md`.
 *
 * MOMENT ② IS THE WHOLE FILE: "Merge overlapping date ranges per industry, SUM the
 * merged length." `industry_months` is a SUM, never a max over rows. The spec pins it
 * numerically three times:
 *
 *   E2·Y   24 mo VMC + 24 mo CNC Turner, both Manufacturing  -> 48   (24 + 24)
 *   E6     12 mo VMC + 60 mo CNC Turner                      -> 72   (12 + 60)
 *   Part 4 ②·B  6 mo VMC + 240 mo factory work               -> 246  (6 + 240)
 *
 * ...and bounds it once, which is why it is a merge and not a plain sum:
 *
 *   E9     VMC Jan-2023..Dec-2024 AND tool-setting in the SAME job -> 24, NOT 48
 *
 * THE COARSE LAUNCH REALITY. Today `worker_skill` rows carry no stint dates, and every
 * row derived for a worker carries the SAME bucketed total (see `derive.ts`). Summing
 * those would multiply his career by his skill count — three skills at 60 months would
 * read as 180. So:
 *
 *   dated rows      -> merge the intervals in that industry, sum the merged length
 *   undated rows    -> fall back to the worker's bucketed TOTAL for that industry
 *   mixed           -> the max of the two, so an undated row can never REDUCE a number
 *                      the dates already justify
 *
 * Then the E8 clamp, PER INDUSTRY: `industry_months = MAX(industry_months,
 * skill_months)` for the skill rows in that same industry. Per-industry is not a
 * detail — E7 has a Fitter with 42 skill months (24 Manufacturing + 18 Construction)
 * against 24 industry months, and that is CORRECT. Clamping against a cross-industry
 * skill sum would force his Manufacturing tenure to 42 and break E7. The clamp only
 * ever compares a skill against tenure in that skill's OWN industry.
 *
 * BUCKETING. The coarse fallback is bucketed (it is an estimate a man gave in
 * conversation — policy D-20). A dated sum is NOT bucketed: those are real calendar
 * months off real stints, the column is literally named `calendar_months`, and rounding
 * them down would delete a month he actually worked.
 *
 * NO CLOCK. An open-ended stint needs an `asOf` date from the caller; without one it
 * contributes zero rather than silently counting up to "now" (E16 — inputs frozen).
 */
import type { IndustryId } from "@badabhai/taxonomy";
import { bucketMonths } from "./months";
import type { WorkerSkillRow } from "./types";

/**
 * Per-industry calendar months, keyed by industry. Only industries the worker actually
 * has rows in appear — an absent industry is 0, not a guess.
 *
 * `totalYears` is the worker's estimated total experience; `null`/unknown contributes
 * 0, leaving the dated stints to speak for themselves.
 *
 * `asOf` closes any ongoing stint. Omit it and an ongoing stint contributes 0 to the
 * dated sum (the coarse fallback and the clamp still apply) — this package has no clock.
 *
 * Counts ALL rows, including `wants: false` ones: tenure is history. Whether a worker
 * WANTS that work is a reach question (`reach.ts`), not a tenure question.
 */
export function computeIndustryTenure(
  rows: readonly WorkerSkillRow[],
  totalYears: number | null | undefined,
  bucket: number,
  asOf?: string | null,
): Map<IndustryId, number> {
  // The coarse fallback: what we can honestly say when a row carries no dates.
  const coarseMonths = bucketMonths(totalYears, bucket);

  const byIndustry = new Map<IndustryId, WorkerSkillRow[]>();
  for (const row of rows) {
    const bucketRows = byIndustry.get(row.industryId);
    if (bucketRows === undefined) byIndustry.set(row.industryId, [row]);
    else bucketRows.push(row);
  }

  const tenure = new Map<IndustryId, number>();
  // Sorted so the map's iteration order is a function of the DATA, not of row order.
  const industryIds = [...byIndustry.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const industryId of industryIds) {
    const industryRows = byIndustry.get(industryId) ?? [];

    // Moment ②: merge the dated stints in THIS industry and sum the merged length.
    const dated = industryRows
      .filter((r): r is WorkerSkillRow & { startedAt: string } => typeof r.startedAt === "string")
      .map((r) => ({ start: r.startedAt, end: r.endedAt }));
    const datedMonths = dated.length > 0 ? calendarMonthsOf(dated, asOf) : 0;

    // Mixed: dates win where they exist, the coarse total is a floor, never a ceiling.
    let months = Math.max(datedMonths, coarseMonths);

    // E8 clamp, per industry.
    for (const r of industryRows) {
      const rowMonths = Number.isFinite(r.monthsBucketed) ? Math.max(0, r.monthsBucketed) : 0;
      if (rowMonths > months) months = rowMonths;
    }

    tenure.set(industryId, months);
  }
  return tenure;
}

/** Months in one industry, 0 when the worker has no history there. */
export function tenureFor(
  tenure: ReadonlyMap<IndustryId, number>,
  industryId: IndustryId,
): number {
  return tenure.get(industryId) ?? 0;
}

/** A half-open stint. `end: null` = ongoing (or unknown end). ISO-8601 dates. */
export interface DateRange {
  start: string;
  end: string | null;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** ISO-8601 date prefix. Accepts a full timestamp; only the date part is used. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parse without a clock — no `Date` object is ever constructed in this package. */
function parseIsoDate(value: string | null | undefined): DateParts | null {
  if (typeof value !== "string") return null;
  const m = ISO_DATE_RE.exec(value);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function compareParts(a: DateParts, b: DateParts): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * Whole calendar months from `a` to `b`, never negative. A partial final month does
 * not count — the same round-down discipline as `bucketMonths`.
 */
export function calendarMonthsBetween(start: string, end: string): number {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (a === null || b === null) return 0;
  const whole = (b.year - a.year) * 12 + (b.month - a.month) - (b.day < a.day ? 1 : 0);
  return whole > 0 ? whole : 0;
}

/**
 * Merge overlapping / touching stints into disjoint ranges (E9).
 *
 * A range whose end precedes its start is DROPPED — it is data corruption, and
 * counting it would credit negative time. A range with `end: null` is open and
 * absorbs everything that starts at or after it.
 *
 * Deterministic: input order does not matter, output is sorted by start.
 */
export function mergeIntervals(ranges: readonly DateRange[]): DateRange[] {
  const parsed = ranges
    .map((r) => ({ range: r, start: parseIsoDate(r.start), end: parseIsoDate(r.end) }))
    .filter(
      (p): p is { range: DateRange; start: DateParts; end: DateParts | null } =>
        p.start !== null && (p.end === null || compareParts(p.end, p.start) >= 0),
    )
    .sort(
      (x, y) =>
        compareParts(x.start, y.start) ||
        // Longest first at an equal start (an open range is the longest of all), so a
        // shorter sibling is absorbed rather than splitting the run.
        (x.end === null ? -1 : y.end === null ? 1 : compareParts(y.end, x.end)),
    );

  const merged: { start: string; startParts: DateParts; end: string | null; endParts: DateParts | null }[] = [];
  for (const p of parsed) {
    const open = p.range.end === null || p.end === null;
    const last = merged[merged.length - 1];
    if (last === undefined) {
      merged.push({ start: p.range.start, startParts: p.start, end: open ? null : p.range.end, endParts: open ? null : p.end });
      continue;
    }
    if (last.endParts === null) continue; // an open range swallows everything after it
    if (compareParts(p.start, last.endParts) <= 0) {
      if (open) {
        last.end = null;
        last.endParts = null;
      } else if (p.end !== null && compareParts(p.end, last.endParts) > 0) {
        last.end = p.range.end;
        last.endParts = p.end;
      }
      continue;
    }
    merged.push({ start: p.range.start, startParts: p.start, end: open ? null : p.range.end, endParts: open ? null : p.end });
  }

  return merged.map((m) => ({ start: m.start, end: m.end }));
}

/**
 * Total calendar months across a set of stints, overlaps counted ONCE (E9).
 *
 * `asOf` closes any open-ended stint. Omit it and an open stint contributes 0 — this
 * package has no clock and will not invent one.
 */
export function calendarMonthsOf(
  ranges: readonly DateRange[],
  asOf?: string | null,
): number {
  let total = 0;
  for (const r of mergeIntervals(ranges)) {
    const end = r.end ?? (typeof asOf === "string" ? asOf : null);
    if (end === null) continue;
    total += calendarMonthsBetween(r.start, end);
  }
  return total;
}

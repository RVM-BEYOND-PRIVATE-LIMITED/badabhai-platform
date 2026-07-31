/**
 * Matching V1 — industry tenure, and the interval merge that will replace it.
 *
 * TWO THINGS LIVE HERE, one live and one waiting:
 *
 *  1. `computeIndustryTenure` — the LAUNCH rule. Coarse history means the honest
 *     per-industry number is `max(bucketed total experience, the longest skill row in
 *     that industry)`. The E8 clamp ("industry_months = MAX(industry_months,
 *     skill_months)") therefore holds BY CONSTRUCTION rather than as a fix-up: a
 *     worker can never show more months on a skill than in the industry that skill
 *     belongs to, because the industry number is defined as the max of the two.
 *
 *  2. `mergeIntervals` / `calendarMonthsOf` — the CORRECT per-job-history maths (E9:
 *     two overlapping stints are 24 calendar months, not 48). Unused at launch and
 *     fully tested, so that turning on per-job history is a data change rather than a
 *     rewrite of the ranking maths under a deadline.
 *
 * NO CLOCK. An open-ended stint needs an `asOf` date from the caller; without one it
 * contributes zero rather than silently counting up to "now" (E16 — inputs frozen).
 */
import type { IndustryId } from "@badabhai/taxonomy";
import { bucketMonths } from "./months";
import type { WorkerSkillRow } from "./types";

/**
 * Per-industry calendar months, keyed by industry. Only industries the worker
 * actually has rows in appear — an absent industry is 0, not a guess.
 *
 * `totalYears` is the worker's estimated total; `null`/unknown contributes 0, so the
 * result falls back to the skill rows alone (the shape per-job history will use).
 *
 * Counts ALL rows, including `wants: false` ones: tenure is history. Whether a worker
 * WANTS that work is a reach question (`reach.ts`), not a tenure question.
 */
export function computeIndustryTenure(
  rows: readonly WorkerSkillRow[],
  totalYears: number | null | undefined,
  bucket: number,
): Map<IndustryId, number> {
  const floorMonths = bucketMonths(totalYears, bucket);
  const tenure = new Map<IndustryId, number>();
  for (const row of rows) {
    const rowMonths = Number.isFinite(row.monthsBucketed)
      ? Math.max(0, row.monthsBucketed)
      : 0;
    const current = tenure.get(row.industryId);
    // The E8 clamp, by construction.
    tenure.set(row.industryId, Math.max(current ?? floorMonths, rowMonths));
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

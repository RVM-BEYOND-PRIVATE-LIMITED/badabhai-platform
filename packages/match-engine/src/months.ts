/**
 * Matching V1 — month bucketing.
 *
 * "Months bucket to 6. No false precision on a number a man estimated."
 *
 * A worker on a chat says "about four years". Storing 48 and ordering on it to the
 * month pretends we know something we do not. Bucketing to 6 makes the difference
 * between 46 and 48 months disappear, which is honest, and makes the ordering stable
 * against a man rounding his own history differently on a different day.
 *
 * ALWAYS ROUNDS DOWN. Bucketing up would inflate a worker's claim.
 */

/**
 * `floor(years * 12 / bucket) * bucket`, clamped at 0.
 *
 * `null`/`undefined`/`NaN`/`Infinity` → 0 ("we do not know" is 0 months, never a
 * guess). A negative input → 0. A non-positive or non-finite bucket falls back to 1
 * (no bucketing) rather than dividing by zero — a bad dial must not produce NaN
 * months that then poison the ordering.
 */
export function bucketMonths(
  totalYears: number | null | undefined,
  bucket: number,
): number {
  if (typeof totalYears !== "number" || !Number.isFinite(totalYears)) return 0;
  const size = Number.isFinite(bucket) && bucket >= 1 ? Math.floor(bucket) : 1;
  const months = totalYears * 12;
  if (months <= 0) return 0;
  return Math.floor(months / size) * size;
}

/**
 * Bucket a value that is ALREADY in months (e.g. a merged calendar-month total from
 * `tenure.ts`). Same rounding-down discipline.
 */
export function bucketMonthValue(
  totalMonths: number | null | undefined,
  bucket: number,
): number {
  if (typeof totalMonths !== "number" || !Number.isFinite(totalMonths)) return 0;
  const size = Number.isFinite(bucket) && bucket >= 1 ? Math.floor(bucket) : 1;
  if (totalMonths <= 0) return 0;
  return Math.floor(totalMonths / size) * size;
}

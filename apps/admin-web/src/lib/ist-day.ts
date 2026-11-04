/**
 * A calendar DAY in India Standard Time, as the instant range it covers — the Events date range
 * (A4, #2574). The operators work in IST (`lib/format.ts` prints every timestamp in it), so "from
 * 1 Nov to 3 Nov" means 1 Nov 00:00 IST through the last millisecond of 3 Nov IST, both inclusive.
 * The API compares instants (`occurredFrom` ≥, `occurredTo` ≤), so the page converts a day here.
 *
 * Pure. IST is a fixed +05:30 with no daylight saving, so a plain offset is exact.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is `value` a `YYYY-MM-DD` day that exists on the calendar (no 31 Feb)? */
export function isCalendarDay(value: string | undefined): value is string {
  const m = value ? DAY.exec(value) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The first instant of IST day `day` ("2026-11-01" → "2026-11-01T00:00:00.000+05:30"). */
export function istDayStart(day: string): string {
  return `${day}T00:00:00.000+05:30`;
}

/** The last instant of IST day `day` ("2026-11-03" → "2026-11-03T23:59:59.999+05:30"). */
export function istDayEnd(day: string): string {
  return `${day}T23:59:59.999+05:30`;
}

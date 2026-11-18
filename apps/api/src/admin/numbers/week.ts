import { daysBetween, istDayOf } from "../../worker-activity/worker-activity";

/**
 * #2755 item 1 — THE WEEK of the numbers screen, defined once.
 *
 * A week is Monday 00:00 to Sunday 23:59:59.999 INDIA TIME (IST, UTC+5:30, no daylight saving),
 * named by the `YYYY-MM-DD` of its Monday. The same rule the CEO's other two screens use (the issue's
 * "one shared week rule"), so a week here and a week there are the same seven days.
 *
 * The IST day of an instant is {@link istDayOf} — the converter `worker_activity` and the pre-pay
 * facts already share (18:30 UTC is IST midnight) — so a day counted here and a day recorded there
 * can never disagree about which day, and therefore which week, an instant belongs to.
 *
 * Pure: no clock, no database. Every caller passes its own instant.
 */

/** The rule, in words, as `GET /admin/numbers/definitions` serves it. */
export const NUMBERS_WEEK_RULE =
  "A week runs from Monday 00:00 to Sunday 23:59:59 India time (IST, UTC+5:30, no daylight " +
  "saving) and is named by the date of its Monday. An instant belongs to the week of its India " +
  "date: Sunday 18:29:59 UTC is still that Sunday, 18:30:00 UTC is already the next Monday.";

/** IST is UTC+5:30 all year. */
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The most weeks {@link weeksBetween} lists: ten years, far above any screen's series. */
export const NUMBERS_MAX_WEEKS_LISTED = 520;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as `YYYY-MM-DD` (2026-02-30 is refused, never rolled over). */
function isIsoDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** `day` moved by `days` whole calendar days (no clock, so no offset or DST involved). */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** True when `day` is a real calendar day that is a Monday — a valid week name. */
export function isWeekStart(day: unknown): day is string {
  if (typeof day !== "string" || !isIsoDay(day)) return false;
  return new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1;
}

/** Throws unless `day` names a week (a real Monday as `YYYY-MM-DD`). */
export function assertWeekStart(day: string): void {
  if (!isWeekStart(day)) throw new RangeError(`not a week start (a Monday as YYYY-MM-DD): ${day}`);
}

/** The week (its Monday, `YYYY-MM-DD`) an instant falls in, India time. */
export function weekStartOf(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new RangeError("weekStartOf needs a valid Date");
  }
  const day = istDayOf(at);
  // getUTCDay of the IST date read as a UTC midnight: 0 = Sunday … 6 = Saturday.
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return shiftDay(day, -((dow + 6) % 7));
}

/** The Sunday (`YYYY-MM-DD`) a week ends on. */
export function weekEndDayOf(weekStart: string): string {
  assertWeekStart(weekStart);
  return shiftDay(weekStart, 6);
}

/**
 * The week as a half-open UTC interval: `fromUtc` is Monday 00:00 IST (Sunday 18:30 UTC) and
 * `toUtcExclusive` the next Monday 00:00 IST. Query with `>= fromUtc AND < toUtcExclusive`, never
 * `<= Sunday 23:59:59`, so no instant in the last second of a week falls between two weeks.
 */
export function weekRange(weekStart: string): { fromUtc: Date; toUtcExclusive: Date } {
  assertWeekStart(weekStart);
  const fromMs = Date.parse(`${weekStart}T00:00:00.000Z`) - IST_OFFSET_MS;
  return { fromUtc: new Date(fromMs), toUtcExclusive: new Date(fromMs + WEEK_MS) };
}

/** The week before. */
export function previousWeek(weekStart: string): string {
  assertWeekStart(weekStart);
  return shiftDay(weekStart, -7);
}

/** The week after. */
export function nextWeek(weekStart: string): string {
  assertWeekStart(weekStart);
  return shiftDay(weekStart, 7);
}

/**
 * Every week from `fromWeek` to `toWeek`, BOTH INCLUDED, oldest first — the series a screen draws
 * and the weeks a recompute walks. Equal weeks give one; `fromWeek` after `toWeek` is an error, as
 * is a span over {@link NUMBERS_MAX_WEEKS_LISTED} weeks.
 *
 * Example: the baseline week of the January target is 2026-11-30, and eight weeks of growth ending
 * Sunday 31 January 2027 need the nine weeks 2026-11-30 … 2027-01-25.
 */
export function weeksBetween(fromWeek: string, toWeek: string): string[] {
  assertWeekStart(fromWeek);
  assertWeekStart(toWeek);
  const span = daysBetween(fromWeek, toWeek);
  if (span < 0) throw new RangeError(`weeksBetween: ${fromWeek} is after ${toWeek}`);
  const count = span / 7 + 1;
  if (count > NUMBERS_MAX_WEEKS_LISTED) {
    throw new RangeError(`weeksBetween: ${count} weeks is over ${NUMBERS_MAX_WEEKS_LISTED}`);
  }
  return Array.from({ length: count }, (_, i) => shiftDay(fromWeek, i * 7));
}

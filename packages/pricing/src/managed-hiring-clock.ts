/**
 * THE MANAGED HIRING CLOCK (#2751 item 7; brief section 2 and 4B.9) — PURE, no I/O, no clock of its
 * own. Every instant in and out is a `Date`; every day is an IST calendar date `YYYY-MM-DD`. India
 * has one time zone and no daylight saving, so an IST day is always 24 hours.
 *
 * THE RULE (owner, 2026-11-18, #2931 answer C1):
 *  - Working days are Monday to Saturday. Sunday is off, and so is every date in `holidays` (the
 *    owner's list is empty today; it is a setting, not code).
 *  - Day 1 is the first working day AFTER the IST day the payment was captured on — a payment at
 *    09:00 on a Monday starts the clock on Tuesday.
 *  - The deadline is the END of the `workingDays`-th working day, IST: the instant the next IST day
 *    begins (`dueAt`).
 *  - The free extension ends `extensionDays` calendar days after day 1 begins (day 1 counts as the
 *    first of them), and never before the deadline.
 *
 *   managedHiringClock({ capturedAt: 2026-11-21 (Sat) 10:00 IST, workingDays: 7, extensionDays: 30 })
 *   → day 1 Mon 23 Nov; deadline end of Mon 30 Nov (Sun 29 skipped); extension ends end of Tue 22 Dec.
 */
import { istDayStartMs } from "./on-sale";

const DAY_MS = 24 * 60 * 60 * 1000;
/** India Standard Time is UTC+05:30 all year. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
/**
 * The most calendar days the clock walks before it gives up: a working-day count the catalogue
 * allows (≤ 60) is reached well inside it unless the holiday list blocks out the calendar, and then
 * the clock fails loud rather than loop.
 */
const MAX_WALK_DAYS = 400;

/** Sunday in `Date.getUTCDay()`. */
const SUNDAY = 0;

export interface ManagedHiringClockInput {
  /** When the payment was captured (the order starts). */
  readonly capturedAt: Date;
  /** Working days to the deadline (≥ 1). */
  readonly workingDays: number;
  /** Calendar days from day 1 to the end of the free extension (≥ 1). */
  readonly extensionDays: number;
  /** IST dates that are not working days, on top of every Sunday. */
  readonly holidays?: readonly string[];
}

export interface ManagedHiringClock {
  /** Day 1: the first working day after the capture's IST day. */
  readonly firstWorkingDay: string;
  /** The last working day before the deadline (the `workingDays`-th). */
  readonly lastWorkingDay: string;
  /** The deadline: the end of `lastWorkingDay`, IST (the next IST day's start). */
  readonly dueAt: Date;
  /** The end of the free extension: `extensionDays` after day 1 began, never before `dueAt`. */
  readonly extensionEndsAt: Date;
}

/** The IST calendar date an instant falls on. */
export function istDateOf(at: Date): string {
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new RangeError("istDateOf expects a valid Date");
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST calendar date `days` after `date` (negative goes back). */
function addDays(date: string, days: number): string {
  const start = istDayStartMs(date);
  if (start === null) throw new RangeError(`not a calendar date: ${date}`);
  return istDateOf(new Date(start + days * DAY_MS));
}

/** Monday to Saturday, and not on the holiday list. */
export function isManagedHiringWorkingDay(date: string, holidays: ReadonlySet<string>): boolean {
  const start = istDayStartMs(date);
  if (start === null) throw new RangeError(`not a calendar date: ${date}`);
  // The weekday of an IST date is the weekday of its UTC calendar twin (same Y-M-D).
  const weekday = new Date(start + IST_OFFSET_MS).getUTCDay();
  return weekday !== SUNDAY && !holidays.has(date);
}

/** The first working day strictly after `date`. */
function nextWorkingDay(date: string, holidays: ReadonlySet<string>): string {
  let day = date;
  for (let i = 0; i < MAX_WALK_DAYS; i += 1) {
    day = addDays(day, 1);
    if (isManagedHiringWorkingDay(day, holidays)) return day;
  }
  throw new RangeError("managed hiring clock: no working day within reach (holiday list?)");
}

/**
 * Compute an order's clock from its capture. Throws a `RangeError` on an invalid input (a bad date,
 * a non-positive count, a holiday that is not a calendar date) — the caller must not start an order
 * on a guessed deadline.
 */
export function managedHiringClock(input: ManagedHiringClockInput): ManagedHiringClock {
  const { workingDays, extensionDays } = input;
  if (!Number.isSafeInteger(workingDays) || workingDays < 1) {
    throw new RangeError(`workingDays must be a positive integer, got: ${workingDays}`);
  }
  if (!Number.isSafeInteger(extensionDays) || extensionDays < 1) {
    throw new RangeError(`extensionDays must be a positive integer, got: ${extensionDays}`);
  }
  const holidays = new Set(input.holidays ?? []);
  for (const h of holidays) {
    if (istDayStartMs(h) === null) throw new RangeError(`holiday is not a calendar date: ${h}`);
  }

  const captureDay = istDateOf(input.capturedAt);
  const firstWorkingDay = nextWorkingDay(captureDay, holidays);
  let lastWorkingDay = firstWorkingDay;
  for (let n = 1; n < workingDays; n += 1) {
    lastWorkingDay = nextWorkingDay(lastWorkingDay, holidays);
  }

  const dueAt = new Date(istDayStartMs(addDays(lastWorkingDay, 1))!);
  const extensionEnd = istDayStartMs(firstWorkingDay)! + extensionDays * DAY_MS;
  const extensionEndsAt = new Date(Math.max(extensionEnd, dueAt.getTime()));
  return { firstWorkingDay, lastWorkingDay, dueAt, extensionEndsAt };
}

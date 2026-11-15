/**
 * #2746 PR 6 — the calendar a campus-drive request is dated in: India's (`Asia/Kolkata`), the
 * company's and the placement team's. Dates are `YYYY-MM-DD`, as Postgres `date` stores them, and
 * compare as strings.
 */

/** How far ahead a preferred window or a drive date may be: one year from today in India. */
export const DRIVE_MAX_DAYS_AHEAD = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar day of `at` in India, as `YYYY-MM-DD`. */
export function indiaDay(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** `day` (`YYYY-MM-DD`) plus `days` calendar days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last day a preferred window or a drive date may fall on: today in India + one year. */
export function latestDriveDay(at: Date = new Date()): string {
  return addDays(indiaDay(at), DRIVE_MAX_DAYS_AHEAD);
}

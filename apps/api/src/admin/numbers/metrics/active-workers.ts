import { daysBetween, lastActiveDayOf } from "../../../worker-activity/worker-activity";
import { distinctCountCells, suppressSmallCells, type NumbersMetricCells } from "./cells";
import type { NumbersActivityRow, NumbersDimsLookup, NumbersWeekWindow } from "./types";

/** The window of "active in the last 30 days": the Sunday and the 29 days before it. */
export const ACTIVE_WINDOW_DAYS = 30;

/**
 * #2753's last active day of one worker AS OF THE WEEK'S END — {@link lastActiveDayOf}, the one
 * definition, reused rather than copied. The rows already hold only what was true by then (his
 * newest `worker_activity` day on or before the Sunday, his newest device sighting before the
 * week's end); the instant handed as "now" is the week's last millisecond, so a sighting can never
 * be read past it.
 */
export function lastActiveDayAsOfWeekEnd(
  row: NumbersActivityRow,
  window: NumbersWeekWindow,
): string | null {
  const endOfWeek = new Date(window.toUtcExclusive.getTime() - 1);
  const seen =
    row.lastSeenAt !== null && row.lastSeenAt.getTime() < window.toUtcExclusive.getTime()
      ? row.lastSeenAt
      : null;
  return lastActiveDayOf(row.activeOn, seen, endOfWeek);
}

/**
 * #2755 metric group 3 — WORKERS ACTIVE IN THE LAST 30 DAYS (`active_workers_30d`), as of the
 * week's Sunday, the rule of `definitions.ts`: his last active day falls in the 30 days ending on
 * that Sunday. Worker figure: small cells suppressed, the total never.
 */
export function activeWorkers30d(
  window: NumbersWeekWindow,
  rows: readonly NumbersActivityRow[],
  workerDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const active = rows.filter((row) => {
    const day = lastActiveDayAsOfWeekEnd(row, window);
    if (day === null) return false;
    const ago = daysBetween(day, window.sunday);
    return ago >= 0 && ago < ACTIVE_WINDOW_DAYS;
  });
  return [
    suppressSmallCells(
      distinctCountCells(
        "active_workers_30d",
        active,
        (r) => r.workerId,
        (r) => workerDims(r.workerId),
      ),
    ),
  ];
}

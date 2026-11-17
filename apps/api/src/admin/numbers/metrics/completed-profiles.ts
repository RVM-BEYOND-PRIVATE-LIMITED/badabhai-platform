import { distinctCountCells, suppressSmallCells, type NumbersMetricCells } from "./cells";
import {
  byWeekEnd,
  inWeek,
  type NumbersCurrentProfileRow,
  type NumbersDimsLookup,
  type NumbersWeekWindow,
} from "./types";

/** The onboarding funnel's `profile_confirmed` step: the current profile's status. */
export const CONFIRMED_PROFILE_STATUS = "confirmed";

/**
 * #2755 metric group 3 — COMPLETED WORKER PROFILES (`completed_profiles`, new in the week) and
 * their total (`completed_profiles_cumulative`), the rules of `definitions.ts`.
 *
 * THE FUNNEL'S RULE, NOT A SECOND ONE (owner question 2 default): a worker's profile is complete
 * when his CURRENT `worker_profiles` row (`CURRENT_PROFILE_ORDER`) is `confirmed`, counted in the
 * week of its `confirmed_at`. A confirmed row with no `confirmed_at` cannot be placed in a week and
 * is not counted. Worker figures: small cells suppressed (the funnel's floor), the total never.
 */
export function completedProfiles(
  window: NumbersWeekWindow,
  profiles: readonly NumbersCurrentProfileRow[],
  workerDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const confirmed = profiles.filter(
    (p): p is NumbersCurrentProfileRow & { confirmedAt: Date } =>
      p.status === CONFIRMED_PROFILE_STATUS && p.confirmedAt !== null,
  );
  const dims = (p: NumbersCurrentProfileRow) => workerDims(p.workerId);
  const key = (p: NumbersCurrentProfileRow) => p.workerId;
  return [
    suppressSmallCells(
      distinctCountCells(
        "completed_profiles",
        confirmed.filter((p) => inWeek(p.confirmedAt, window)),
        key,
        dims,
      ),
    ),
    suppressSmallCells(
      distinctCountCells(
        "completed_profiles_cumulative",
        confirmed.filter((p) => byWeekEnd(p.confirmedAt, window)),
        key,
        dims,
      ),
    ),
  ];
}

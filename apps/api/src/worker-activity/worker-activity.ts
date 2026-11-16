import type { ServerConfig } from "@badabhai/config";
import { lastActiveOnOf } from "../match/pre-pay-facts";

/** The two config keys the last-active day and its mark read. */
export type WorkerActivityConfig = Pick<
  ServerConfig,
  "WORKER_ACTIVITY_ENABLED" | "NOT_RECENTLY_ACTIVE_DAYS"
>;

/**
 * `WORKER_ACTIVITY_ENABLED` (#2753) — THE ONE READ of the switch. Only `true` turns it on; unset,
 * empty and a missing config object are off, so a caller that was never handed the config fails
 * closed to today: nothing written, nothing read, no `notRecentlyActive` key.
 */
export function workerActivityEnabled(config: WorkerActivityConfig | undefined): boolean {
  return config?.WORKER_ACTIVITY_ENABLED === true;
}

/** The owner's default (#2753): more than 90 days since the last active day marks him. */
export const DEFAULT_NOT_RECENTLY_ACTIVE_DAYS = 90;

/**
 * The IST calendar day (`yyyy-mm-dd`) of an instant. The same converter the #2747 pre-pay fact
 * uses (`lastActiveOnOf`, 18:30 UTC is IST midnight), so a day written here and a device sighting
 * read there can never disagree about which day an instant belongs to.
 */
export function istDayOf(at: Date): string {
  // Never null for a real Date: the helper returns null only for a missing or unparseable value.
  return lastActiveOnOf(at, at) as string;
}

/**
 * THE ONE DEFINITION of a worker's last active day: the later of the newest day `worker_activity`
 * holds for him and the IST day of his newest device sighting. The device term carries the history
 * from before the table (and the days the switch was off), which is why the table needs no
 * backfill. Both are `yyyy-mm-dd`, so the later one is the larger string. Neither → null.
 */
export function lastActiveDayOf(
  activeOn: string | null,
  lastSeenAt: Date | string | null,
  now: Date,
): string | null {
  const day = typeof activeOn === "string" && ISO_DAY.test(activeOn) ? activeOn : null;
  const seen = lastActiveOnOf(lastSeenAt, now);
  if (day === null) return seen;
  if (seen === null) return day;
  return day > seen ? day : seen;
}

/** Whole calendar days from `day` to `today`, both `yyyy-mm-dd` (no time, so no DST or offset). */
export function daysBetween(day: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
}

/**
 * The "not recently active" mark (#2753 item 7): true exactly when he HAS a last active day and
 * today (IST) is MORE than `thresholdDays` after it. With the default 90: last active 90 days ago
 * is not marked, 91 days ago is. No day at all is not marked: the mark says "he has gone quiet",
 * and a worker who has never been seen has not gone anywhere (the card already says "not given").
 */
export function isNotRecentlyActive(
  lastActiveDay: string | null | undefined,
  today: string,
  thresholdDays: number,
): boolean {
  if (typeof lastActiveDay !== "string" || !ISO_DAY.test(lastActiveDay)) return false;
  return daysBetween(lastActiveDay, today) > thresholdDays;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

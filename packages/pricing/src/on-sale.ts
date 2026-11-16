/**
 * Whether a credit pack is ON SALE (#2749, brief section 2) — PURE, no I/O, no clock of its own.
 *
 * A pack can be in the catalogue and still not be for sale:
 *  - `offered: false` takes it off sale (absent means offered);
 *  - `onSaleFrom: "YYYY-MM-DD"` holds it back until 00:00 IST on that date. India has one time
 *    zone and no daylight saving, so the day starts at 18:30 UTC the evening before.
 *
 * Both the payer catalogue read (which tiers a company is shown) and the purchase path (which
 * codes a company may order) ask THIS function, so a pack that is hidden cannot be ordered and a
 * pack that can be ordered is shown.
 */
import type { CreditPackTier } from "./types";

/** India Standard Time is UTC+05:30 all year (no daylight saving). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant 00:00 IST begins on a `YYYY-MM-DD` date, in epoch milliseconds, or null when the
 * string is not a real calendar date (bad shape, month 13, 30 February, a year before 100).
 *
 *   istDayStartMs("2027-04-01") === Date.parse("2027-03-31T18:30:00.000Z")
 */
export function istDayStartMs(date: string): number | null {
  const match = CALENDAR_DATE_RE.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMidnight = Date.UTC(year, month - 1, day);
  // Date.UTC rolls an impossible date over (30 Feb → 2 Mar) and maps years 0–99 to 1900–1999;
  // reading the parts back refuses both.
  const check = new Date(utcMidnight);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return utcMidnight - IST_OFFSET_MS;
}

/**
 * True when `tier` may be shown and sold at `now`.
 *
 * FAIL-CLOSED: an invalid `now`, or an `onSaleFrom` that is not a real date (only possible for a
 * tier that skipped the catalogue schema), is NOT on sale.
 */
export function isCreditPackOnSale(tier: CreditPackTier, now: Date): boolean {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) return false;
  if (tier.offered === false) return false;
  if (tier.onSaleFrom === undefined) return true;
  const startMs = istDayStartMs(tier.onSaleFrom);
  return startMs !== null && nowMs >= startMs;
}

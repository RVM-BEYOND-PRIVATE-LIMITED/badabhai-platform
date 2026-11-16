/**
 * #2753 item 11 — the partner's share of a pay-on-joining fee. THE ONE COMPUTATION; the server
 * calls it on create and on every fee change, and no client ever sends a share.
 *
 * FLOOR, IN INTEGER ARITHMETIC: floor(fee_paise * percent / 100). BadaBhai keeps the remainder
 * paisa, so the partner is never paid a paisa the arithmetic did not owe. Computed with BigInt,
 * never a float product: `fee * 70` passes 2^53 for a fee above ~1.29e14 paise and a float floor
 * would then be off by whole paise. Migration 0171's `pay_on_joining_hires_share_math_chk` holds
 * the database to the same formula (Postgres bigint division truncates, the floor for a
 * non-negative fee), and `pay_on_joining.recorded` refuses any other figure.
 *
 * GUARDED, NOT CLAMPED: a fee that is not a non-negative safe integer, or a percent outside
 * 0..100, throws. The request DTO and the config schema refuse both long before this runs; a throw
 * here is a programming error, never a client error.
 */
export function partnerSharePaise(feePaise: number, percent: number): number {
  if (!Number.isSafeInteger(feePaise) || feePaise < 0) {
    throw new RangeError("fee_paise must be a non-negative safe integer");
  }
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError("the partner share percent must be a whole number from 0 to 100");
  }
  // The result is at most the fee itself, so it is always a safe integer again.
  return Number((BigInt(feePaise) * BigInt(percent)) / 100n);
}

/**
 * GST on a credit pack's price (#2749, brief section 2: "GST is always extra") — PURE, integer
 * arithmetic only. No float ever touches a money value here.
 *
 * UNITS. The catalogue prices packs in WHOLE RUPEES (ADR-0013). Tax needs paise, so every field
 * this module returns is an integer number of PAISE, beside the rupee price, never replacing it.
 *
 * THE RULE (the issue's "GST arithmetic"):
 *  1. taxable  = price × 100                                  (paise; exact)
 *  2. gst      = taxable × rate ÷ 10,000, rounded half-up to the paisa
 *  3. total    = taxable + gst, rounded half-up to the whole RUPEE (a multiple of 100 paise)
 *  4. roundOff = total − taxable − gst
 *
 * `roundOff` is whatever step 3 added or removed: from −49 to +50 paise. It is NEGATIVE when the
 * rupee rounds down (₹1,001: 1,00,100 + 18,018 = 1,18,118 paise → ₹1,181, round-off −18) and
 * positive when it rounds up (₹999: 99,900 + 17,982 = 1,17,882 → ₹1,179, round-off +18).
 * taxable + gst + roundOff === total, always.
 *
 *   gstPriceLine(999) → { taxablePaise: 99900, gstPaise: 17982, roundOffPaise: 18,
 *                          totalPaise: 117900, gstRateBps: 1800 }
 *   formatPackPriceLine(999) === "₹999 plus GST (₹1,179)"
 *
 * Whether an invoice prints a round-off line or rounds the tax itself to the rupee is the
 * accountant's question (the issue's "GST arithmetic"); the total does not change either way.
 */
import { formatInr } from "./format";

/** GST on a credit pack: 18%, in basis points (1 bps = 0.01%). */
export const GST_RATE_BPS = 1800;

const BPS_PER_WHOLE = 10_000;
const PAISE_PER_RUPEE = 100;

/** One price, taxed. Every amount is an integer number of paise. */
export interface GstPriceLine {
  /** The pack price before GST, in paise (price × 100). */
  readonly taxablePaise: number;
  /** GST on `taxablePaise` at `gstRateBps`, rounded half-up to the paisa. */
  readonly gstPaise: number;
  /** What rounding the total to the rupee added (positive) or removed (negative): −49 … +50. */
  readonly roundOffPaise: number;
  /** What the buyer pays: a whole number of rupees, in paise. */
  readonly totalPaise: number;
  /** The rate applied, in basis points (1800 = 18%). */
  readonly gstRateBps: number;
}

/** `numerator ÷ denominator` rounded half-up, for a non-negative integer numerator. Exact. */
function roundHalfUpDiv(numerator: number, denominator: number): number {
  const remainder = numerator % denominator;
  const quotient = (numerator - remainder) / denominator;
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}

/**
 * Tax a whole-rupee price. Throws a `RangeError` for a price that is not a non-negative integer,
 * a rate outside 0–10,000 bps, or an amount too large to keep exact — fail loud rather than
 * return a wrong amount.
 *
 * `rateBps` defaults to {@link GST_RATE_BPS}; it is a parameter so the rounding can be tested at
 * a rate where half-paise occur (at 18% of a whole-rupee price they never do).
 */
export function gstPriceLine(priceInr: number, rateBps: number = GST_RATE_BPS): GstPriceLine {
  if (!Number.isSafeInteger(priceInr) || priceInr < 0) {
    throw new RangeError(
      `gstPriceLine expects a non-negative integer (whole rupees), got: ${priceInr}`,
    );
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > BPS_PER_WHOLE) {
    throw new RangeError(`gstPriceLine expects a rate of 0–${BPS_PER_WHOLE} bps, got: ${rateBps}`);
  }
  const taxablePaise = priceInr * PAISE_PER_RUPEE;
  // Bound at the HIGHEST rate, so whether a price is accepted never depends on the rate.
  if (!Number.isSafeInteger(taxablePaise * BPS_PER_WHOLE)) {
    throw new RangeError(`gstPriceLine cannot tax ₹${priceInr} exactly (amount too large)`);
  }
  const gstPaise = roundHalfUpDiv(taxablePaise * rateBps, BPS_PER_WHOLE);
  const totalPaise = roundHalfUpDiv(taxablePaise + gstPaise, PAISE_PER_RUPEE) * PAISE_PER_RUPEE;
  return {
    taxablePaise,
    gstPaise,
    roundOffPaise: totalPaise - taxablePaise - gstPaise,
    totalPaise,
    gstRateBps: rateBps,
  };
}

/**
 * The brief's display line for a pack price (B4C-06): `₹999 plus GST (₹1,179)`. Both amounts are
 * whole rupees with en-IN grouping, through {@link formatInr}; the bracket is the GST total.
 */
export function formatPackPriceLine(priceInr: number): string {
  return formatGstPriceLine(gstPriceLine(priceInr));
}

/**
 * {@link formatPackPriceLine} for a line already computed, so a caller that holds the line does
 * not tax the price twice. Both amounts come from the line itself, so they cannot disagree.
 */
export function formatGstPriceLine(line: GstPriceLine): string {
  // Both are whole rupees by construction (taxable = price × 100; total rounded to the rupee in
  // step 3), so these divisions are exact.
  const priceInr = line.taxablePaise / PAISE_PER_RUPEE;
  const totalInr = line.totalPaise / PAISE_PER_RUPEE;
  return `${formatInr(priceInr)} plus GST (${formatInr(totalInr)})`;
}

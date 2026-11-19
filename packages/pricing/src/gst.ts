/**
 * GST on a credit pack's price (#2749, brief section 2: "GST is always extra") — PURE, integer
 * arithmetic only. No float ever touches a money value here.
 *
 * UNITS. The catalogue prices packs in WHOLE RUPEES (ADR-0013). Tax needs paise, so every field
 * this module returns is an integer number of PAISE, beside the rupee price, never replacing it.
 *
 * THE RULE (owner ruling 2026-11-18, #2749 part 4: "GST rounded to the rupee, no round-off line"):
 *  1. taxable  = price × 100                                            (paise; exact)
 *  2. gst      = taxable × rate ÷ 10,000, rounded half-up to the whole RUPEE (a multiple of 100)
 *  3. total    = taxable + gst                                          (a whole rupee)
 *  4. roundOff = 0, always. The field (and `payment_orders.round_off_paise`) is kept so no reader
 *     or column changes shape; it can no longer carry anything.
 *
 * ONE rounding, on the tax itself, so the invoice prints the GST it charges and no round-off line.
 * At 18% the total is the same whole rupee the earlier rule gave (total rounded, tax to the paisa)
 * for every whole-rupee price: ₹999 → GST ₹179.82 → ₹180, total ₹1,179 either way.
 *
 *   gstPriceLine(999) → { taxablePaise: 99900, gstPaise: 18000, roundOffPaise: 0,
 *                          totalPaise: 117900, gstRateBps: 1800 }
 *   formatPackPriceLine(999) === "₹999 plus GST (₹1,179)"
 *
 * An order stamped under the earlier rule (GST to the paisa, a round-off) keeps its stored columns;
 * its invoice reads the GST as total − taxable, which is the same whole rupee
 * (`apps/api/src/invoices`). The CGST / SGST / IGST split is {@link splitGstForSupply}.
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
  /** GST on `taxablePaise` at `gstRateBps`, rounded half-up to the whole rupee (in paise). */
  readonly gstPaise: number;
  /**
   * Always 0 since the GST itself is rounded to the rupee (owner ruling 2026-11-18). Kept so the
   * line, the catalogue response and `payment_orders.round_off_paise` keep their shape.
   */
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
 * a rate where the tax lands exactly on half a rupee.
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
  // One rounding, straight to the rupee: taxable × rate ÷ (10,000 × 100) rupees, half-up.
  const gstPaise =
    roundHalfUpDiv(taxablePaise * rateBps, BPS_PER_WHOLE * PAISE_PER_RUPEE) * PAISE_PER_RUPEE;
  return {
    taxablePaise,
    gstPaise,
    roundOffPaise: 0,
    totalPaise: taxablePaise + gstPaise,
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
  // Both are whole rupees by construction (taxable = price × 100; the GST rounded to the rupee in
  // step 2), so these divisions are exact.
  const priceInr = line.taxablePaise / PAISE_PER_RUPEE;
  const totalInr = line.totalPaise / PAISE_PER_RUPEE;
  return `${formatInr(priceInr)} plus GST (${formatInr(totalInr)})`;
}

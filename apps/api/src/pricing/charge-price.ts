import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { resolvePrice, type Catalog, type ResolveRequest, type ResolveResult } from "@badabhai/pricing";

/**
 * THE price a payer purchase route charges for (product, tier) at one instant — the single
 * source of truth for "shown == charged" (#2085).
 *
 * Every charge path reads its price through here: {@link PostingPlansService} (plan, boost,
 * quota top-up, capacity) and {@link PaymentGateway.resolvePack} (credit packs, mock and real).
 * The payer catalog read (`GET /payer/pricing/catalog`) prices each tier through the SAME call,
 * so a price the portal displays can only differ from the charge if the catalog, an offer
 * window or a coupon changed in between — which is what `expected_price_inr` catches.
 *
 * CREDIT PACKS ARE CHARGED AT LIST PRICE. The credit-pack path has always charged
 * `tier.priceInr` and never applied an offer or coupon (D-6). That is preserved here rather
 * than changed under a display ticket: an offer scoped to a credit pack is NOT honoured by
 * the charge, so the catalog must not advertise it either. Changing that is a pricing
 * decision, and it lands HERE — once — for both the charge and the display.
 */
export function chargeQuote(catalog: Catalog, request: ResolveRequest): ResolveResult {
  const result = resolvePrice(catalog, request);
  if (!result.ok || result.quote.kind !== "credit_pack") return result;
  const { quote } = result;
  return {
    ok: true,
    quote: {
      ...quote,
      discountInr: 0,
      finalInr: quote.basePriceInr,
      offerApplied: null,
      couponApplied: null,
    },
  };
}

/**
 * Optional client guard on every payer purchase route (#2085): the ₹ the payer CONFIRMED.
 * It is never a price the server charges — the charge is always server-resolved (XT5); this
 * only lets the server REFUSE when the two differ. A non-negative whole-rupee integer.
 */
export const expectedPriceInrSchema = z.number().int().min(0).max(10_000_000);

/** The 409 body a purchase gets when the confirmed price is not the price it would be charged. */
export interface PriceMismatchErrorBody {
  readonly statusCode: 409;
  readonly error: "Conflict";
  readonly message: string;
  readonly reason: "price_mismatch";
  readonly expected_price_inr: number;
  readonly current_price_inr: number;
}

/**
 * Refuse a purchase whose confirmed price is not the price about to be charged. Fails CLOSED:
 * callers run it BEFORE any write, payment event or ledger row, so a refusal charges nothing.
 * `expected === undefined` is a legacy client and is a no-op (behaviour unchanged).
 */
export function assertExpectedPrice(expected: number | undefined, currentPriceInr: number): void {
  if (expected === undefined || expected === currentPriceInr) return;
  throw new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message:
      `The price changed: you confirmed ₹${expected} but the current price is ₹${currentPriceInr}. ` +
      `Nothing was charged; re-read the price and confirm again`,
    reason: "price_mismatch",
    expected_price_inr: expected,
    current_price_inr: currentPriceInr,
  } satisfies PriceMismatchErrorBody);
}

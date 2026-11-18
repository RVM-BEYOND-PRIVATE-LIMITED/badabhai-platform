import { NotFoundException } from "@nestjs/common";
import type { ProductKind } from "@badabhai/pricing";
import type { ServerConfig } from "@badabhai/config";

/**
 * #2749 item 11 (ADR-0065) — THE PAID PRODUCTS THE BRIEF DROPS, and the one switch that takes
 * them off sale: `RETIRED_PRODUCTS_OFF_SALE` (default false, so they stay on sale until the owner
 * switches it).
 *
 * The brief sells credit packs and nothing else (no paid posting, no paid ranking, no discounts).
 * So while the switch is on, every catalogue product kind EXCEPT {@link KINDS_SOLD_AFTER_RETIREMENT}
 * is retired: posting plans, boosts (the retired `all_candidates` tier included), hiring capacity
 * and quota top-ups, and with them every offer and coupon, which only ever applied to these (a
 * credit pack is charged at list price: `chargeQuote`). It is an ALLOW-list on purpose: a product
 * kind added to the catalogue later is off sale too while the switch is on, until it is named here.
 *
 * What the switch does: the payer catalogue (`PricingService.getPayerCatalog`) leaves retired
 * products out, and every purchase of one (`PostingPlansService`: plan, boost, quota top-up,
 * capacity, on the payer and the ops routes alike) answers the neutral 404 of a route that does not
 * exist. What it never does: hide or change anything already bought. Plans, boosts, top-ups and
 * capacity already running run to their end date, and every read of them (posting stats, the
 * capacity view, payment history, the admin pages) is unchanged.
 */
export const KINDS_SOLD_AFTER_RETIREMENT: readonly ProductKind[] = ["credit_pack"];

/** Is the switch on? The one reader of `RETIRED_PRODUCTS_OFF_SALE` (a static test pins it). */
export function retiredProductsOffSale(
  config: Pick<ServerConfig, "RETIRED_PRODUCTS_OFF_SALE">,
): boolean {
  return config.RETIRED_PRODUCTS_OFF_SALE === true;
}

/** True when `kind` is off sale under `config` (always false while the switch is off). */
export function isProductKindOffSale(
  config: Pick<ServerConfig, "RETIRED_PRODUCTS_OFF_SALE">,
  kind: ProductKind,
): boolean {
  return retiredProductsOffSale(config) && !KINDS_SOLD_AFTER_RETIREMENT.includes(kind);
}

/**
 * The refusal of a retired product's purchase: the bare 404 a route that does not exist answers
 * (the same body `POST /payer/credits/order` gives while real payments are off), so it says
 * nothing about a posting, a tier or the switch. Thrown before any read or write.
 */
export function retiredProductNotFound(): NotFoundException {
  return new NotFoundException();
}

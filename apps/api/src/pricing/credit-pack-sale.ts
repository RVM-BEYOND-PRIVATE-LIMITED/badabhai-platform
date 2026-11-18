import {
  gstPriceLine,
  isCreditPackOnSale,
  type Catalog,
  type CreditPackTier,
  type GstPriceLine,
  type Quote,
} from "@badabhai/pricing";
import { chargeQuote } from "./charge-price";
import type { ActiveCatalog } from "./pricing.service";

/**
 * WHETHER A CREDIT PACK CAN BE SOLD RIGHT NOW (#2749) — the ONE answer both read paths use.
 *
 * `GET /payer/pricing/catalog` shows a pack only when {@link creditPackSale} says it is sellable,
 * and `PaymentGateway.resolvePack` sells a pack only on the same answer, so a pack a company is
 * shown can be ordered and a pack it cannot see cannot be. Pure: no I/O, the clock is a parameter.
 */

/** The one credit-pack product the purchase path sells. The payer catalogue shows only this one. */
export const CREDIT_PACK_PRODUCT = "contact_unlock";

/**
 * True when a stored catalogue row EXISTS but failed validation, so the engine is serving
 * DEFAULT_CATALOG in its place. `getActiveCatalog` reports "no row" as revision 0 and a rejected
 * row with that row's own revision, which is always ≥ 1 (the column defaults to 1 and
 * `updateCatalog` writes the current revision + 1).
 *
 * In that state nothing is sold: falling back would put the DEFAULT_CATALOG packs back on sale
 * in place of the catalogue ops published. With NO row (production today) the default IS the
 * catalogue, and its packs sell as before.
 */
export function isRejectedCatalogRow(active: Pick<ActiveCatalog, "source" | "revision">): boolean {
  return active.source === "default" && active.revision > 0;
}

/** A pack that can be sold now: its tier, its charge quote, the credits it grants, its GST line. */
export interface SellablePack {
  readonly tier: CreditPackTier;
  readonly quote: Quote;
  readonly credits: number;
  readonly priceLine: GstPriceLine;
}

/** Whether one tier can be sold now, and if not, why. */
export type CreditPackSale =
  | { readonly sellable: true; readonly pack: SellablePack }
  | { readonly sellable: false; readonly reason: "rejected_row" | "off_sale" | "unpriced" }
  /** The GST line could not be computed (a price too large to tax exactly). Callers log it. */
  | { readonly sellable: false; readonly reason: "gst_error"; readonly errorClass: string };

/** The {@link CREDIT_PACK_PRODUCT} tier for `packCode` in `catalog`, or undefined. */
export function findCreditPackTier(catalog: Catalog, packCode: string): CreditPackTier | undefined {
  const product = catalog.products.find(
    (p) => p.kind === "credit_pack" && p.code === CREDIT_PACK_PRODUCT,
  );
  if (product?.kind !== "credit_pack") return undefined;
  return product.tiers.find((t) => t.code === packCode);
}

/**
 * Whether `tier` (a tier of {@link CREDIT_PACK_PRODUCT} in `active.catalog`) can be sold at `now`.
 * Not sellable when the stored row was rejected, when the tier is off sale
 * (`isCreditPackOnSale`), when the engine cannot price it, or when its GST line cannot be computed.
 */
export function creditPackSale(
  active: ActiveCatalog,
  tier: CreditPackTier,
  now: Date,
): CreditPackSale {
  if (isRejectedCatalogRow(active)) return { sellable: false, reason: "rejected_row" };
  if (!isCreditPackOnSale(tier, now)) return { sellable: false, reason: "off_sale" };
  // Priced through `chargeQuote`, the one charge function (#2085): list price for a credit pack.
  const result = chargeQuote(active.catalog, {
    productCode: CREDIT_PACK_PRODUCT,
    tierCode: tier.code,
    now,
  });
  if (!result.ok || result.quote.grants.kind !== "credit_pack") {
    return { sellable: false, reason: "unpriced" };
  }
  try {
    const priceLine = gstPriceLine(result.quote.finalInr);
    return {
      sellable: true,
      pack: { tier, quote: result.quote, credits: result.quote.grants.credits, priceLine },
    };
  } catch (err) {
    return { sellable: false, reason: "gst_error", errorClass: errorClassOf(err) };
  }
}

/** The class name of a thrown value, for a log line that never carries the message itself. */
function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

import "server-only";
import { z } from "zod";
import { DEFAULT_CATALOG, productSchema, type Product } from "@badabhai/pricing";
import { payerFetch } from "./payer-http";
import type { TierPrice } from "./pricing-config";

/**
 * The LIVE pricing catalog seam (context-drift D-6).
 *
 * The portal used to render every price from the COMPILE-TIME `DEFAULT_CATALOG`, so an
 * ops catalog edit (the ADR-0013 config path) never reached payers without a rebuild.
 * This module fetches the ACTIVE catalog from the payer-authed
 * `GET /payer/pricing/catalog` (products-only projection, validated server-side by the
 * fail-closed pricing engine) and every pricing render site consumes ITS products via
 * the pure `pricing-config` readers.
 *
 * FALLBACK (documented, deliberate): on ANY fetch/parse failure the compile-time
 * `DEFAULT_CATALOG` products are returned with `live:false`, and the page renders a
 * subtle "cached pricing" note — never a blank page. Failing OPEN to defaults is
 * CORRECT here because this seam is price DISPLAY only: the server re-resolves the
 * real price through the pricing engine at every charge (XT5), so a stale display can
 * never change what is charged — and since #2085 a purchase sends back the price the
 * payer confirmed, so a stale price is REFUSED (409 `price_mismatch`), never charged.
 *
 * EFFECTIVE PRICES (#2085): `prices` is the API's per-tier charge price (`prices[]`,
 * computed by the same function the purchase routes charge through, active offer
 * included). It is null when the API sent none — an API older than #2085, or the
 * fallback above — and the readers then show each tier's catalog price.
 *
 * AUTH NOTE: the catch swallows a 401 too (it does NOT redirect). That is safe, not a
 * hole: every consumer sits under `(portal)/layout.tsx`, whose `requirePayer()` already
 * resolved the session (or redirected to /login) BEFORE the page ran — so this can never
 * render a portal page to an unauthed visitor. A session that expires mid-render degrades
 * to cached pricing here and redirects on the next navigation/mutation, which is the
 * right trade for a display-only read: pricing must never be what blanks the page.
 */
export interface LiveCatalog {
  /** The priced products to render from — live wire products, or the compile-time fallback. */
  readonly products: readonly Product[];
  /** Each tier's charge price (#2085), or null when the API sent none (older API / fallback). */
  readonly prices: readonly TierPrice[] | null;
  /** false ⇒ the fetch failed and `products` is the DEFAULT_CATALOG fallback ("cached pricing"). */
  readonly live: boolean;
}

/**
 * One `prices[]` row — mirrors the API's `PayerTierPrice` exactly
 * (apps/api/src/pricing/pricing.service.ts).
 */
const payerTierPriceWireSchema = z.object({
  product_code: z.string().min(1),
  tier_code: z.string().min(1),
  base_price_inr: z.number().int().nonnegative(),
  price_inr: z.number().int().nonnegative(),
  discount_inr: z.number().int().nonnegative(),
  offer: z.object({ code: z.string().min(1), ends_at: z.string().min(1) }).nullable(),
});

/**
 * The `GET /payer/pricing/catalog` wire shape — the SAME `productSchema` the backend
 * catalog validates against (@badabhai/pricing owns the shape on both sides, so the
 * contract cannot drift; invariant #7). `revision`/`source` are provenance we accept
 * but do not surface: source:"default" is the SERVER failing closed to its typed
 * default — still exactly what it would charge, so it renders as live.
 *
 * `prices` + `priced_at` are ADDITIVE (#2085): `.nullish()` + default null, so an API that
 * predates them (no keys at all) still parses (forward/backward compatible, invariant #8).
 * `priced_at` is validated but not surfaced — an offer that closes after it is what the
 * purchase's `expected_price_inr` catches.
 */
const payerCatalogWireSchema = z.object({
  revision: z.number().int().min(0),
  source: z.enum(["db", "default"]),
  products: z.array(productSchema).min(1),
  prices: z.array(payerTierPriceWireSchema).nullish().default(null),
  priced_at: z.string().min(1).nullish().default(null),
});

/** Fetch the live catalog; fail OPEN to the compile-time defaults (display-only seam). */
export async function getLiveCatalog(): Promise<LiveCatalog> {
  try {
    const wire = await payerFetch("/payer/pricing/catalog", { schema: payerCatalogWireSchema });
    return {
      products: wire.products,
      prices:
        wire.prices?.map((p) => ({
          productCode: p.product_code,
          tierCode: p.tier_code,
          basePriceInr: p.base_price_inr,
          priceInr: p.price_inr,
          discountInr: p.discount_inr,
          offer: p.offer ? { code: p.offer.code, endsAt: p.offer.ends_at } : null,
        })) ?? null,
      live: true,
    };
  } catch {
    // Fetch/parse/auth failure → the documented fallback. No reason is surfaced (the
    // page shows the neutral "cached pricing" note); prices stay enforced server-side.
    return { products: DEFAULT_CATALOG.products, prices: null, live: false };
  }
}

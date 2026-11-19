import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  safeParseCatalog,
  resolvePrice,
  formatGstPriceLine,
  DEFAULT_CATALOG,
  type Catalog,
  type GstPriceLine,
  type Product,
  type Quote,
  type ResolveResult,
} from "@badabhai/pricing";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { PricingRepository } from "./pricing.repository";
import type { UpdateCatalogDto, QuoteQueryDto } from "./pricing.dto";
import { chargeQuote } from "./charge-price";
import { CREDIT_PACK_PRODUCT, creditPackSale, type SellablePack } from "./credit-pack-sale";
import { isProductKindOffSale } from "./retired-products";

/** The active catalog + provenance (fail-closed: falls back to the typed default). */
export interface ActiveCatalog {
  readonly catalog: Catalog;
  readonly revision: number;
  /** "db" = a valid stored catalog; "default" = no row OR an invalid row (fail-closed). */
  readonly source: "db" | "default";
}

/**
 * The price one catalog tier would be CHARGED at `priced_at` (#2085), without a coupon.
 * Computed by {@link chargeQuote} — the function every purchase route charges through — so
 * `price_inr` here is the number a purchase of this tier takes at that instant.
 */
export interface PayerTierPrice {
  readonly product_code: string;
  readonly tier_code: string;
  /** The catalog list price. */
  readonly base_price_inr: number;
  /** What a purchase of this tier is charged now (after the active offer, if any). */
  readonly price_inr: number;
  /** base − price (≥ 0). */
  readonly discount_inr: number;
  /** The automatic offer the charge applies right now, or null. Never a coupon. */
  readonly offer: { readonly code: string; readonly ends_at: string } | null;
}

/**
 * A credit pack's price with GST (#2749): integer paise, plus the brief's display line.
 *
 * THIS IS WHAT A PURCHASE CHARGES (#2749 PR 3): `POST /payer/credits/order` creates the Razorpay
 * order for `totalPaise`, from the same `creditPackSale` line this is built from, so shown ==
 * charged. `expected_price_inr` is still compared with the tier's `priceInr`, the list price
 * before GST. (The MOCK `POST /payer/credits`, which takes no money and is retired when real
 * payments switch on, still stamps `priceInr` on its ledger line, as it always has.)
 */
export interface PayerPackPrice extends GstPriceLine {
  /** e.g. `₹999 plus GST (₹1,179)` (B4C-06). */
  readonly display: string;
}

/**
 * One credit-pack tier as a payer sees it (#2749) — built from a WHITELIST, never the stored tier
 * object, so a tier field added to the catalogue schema (or a hidden pack's `onSaleFrom` /
 * `offered`) never ships by default.
 */
export interface PayerCreditPackTier {
  readonly code: string;
  /** The list price before GST, whole rupees (the catalogue contract, ADR-0013). */
  readonly priceInr: number;
  readonly credits: number;
  /** The OLD 14-day contact-access window, kept for older readers. Not how long credits last. */
  readonly windowDays: number;
  /** How long the credits from this pack last, in days, or null when the catalogue sets none. */
  readonly validityDays: number | null;
  /** The charge price taxed: base, GST, round-off and total in paise, and the display line. */
  readonly price: PayerPackPrice;
}

/** The credit-pack product as a payer sees it: only `contact_unlock`, only its tiers on sale (#2749). */
export interface PayerCreditPackProduct {
  readonly kind: "credit_pack";
  readonly code: string;
  readonly tiers: readonly PayerCreditPackTier[];
}

/**
 * A product in the payer catalogue. Credit packs are projected ({@link PayerCreditPackProduct});
 * every other kind ships as the catalogue holds it while it is on sale, and not at all once
 * `RETIRED_PRODUCTS_OFF_SALE` retires it (#2749 item 11, `retired-products.ts`).
 */
export type PayerProduct = Exclude<Product, { kind: "credit_pack" }> | PayerCreditPackProduct;

/**
 * The payer-facing catalog projection (D-6 + #2085 + #2749). `prices` + `priced_at` are
 * ADDITIVE (#2085): the effective per-tier charge price and the active offer behind it.
 * Credit packs (#2749): only `contact_unlock` (the one product the purchase path sells), and only
 * its tiers that can be sold now, appear, in `products` AND in `prices`, each built from a
 * whitelist with its GST price line; with nothing sellable the product is left out. Other
 * products are unchanged while on sale, and absent (from `products` and `prices`) once
 * `RETIRED_PRODUCTS_OFF_SALE` retires them (#2749 item 11). Coupons, coupon caps and
 * `floorPriceInr` never ship.
 */
export interface PayerCatalogView {
  readonly revision: number;
  readonly source: "db" | "default";
  readonly products: readonly PayerProduct[];
  readonly prices: readonly PayerTierPrice[];
  /** The instant `prices` were resolved at (ISO-8601). An offer window can close after it. */
  readonly priced_at: string;
}

/**
 * The payer's view of one sellable credit-pack tier (#2749 whitelist). The GST line was computed
 * once, by `creditPackSale`, and both the paise fields and `display` come from it. `price.totalPaise`
 * is what an order for this tier charges (#2749 PR 3; see {@link PayerPackPrice}).
 */
function toPayerCreditPackTier({ tier, priceLine }: SellablePack): PayerCreditPackTier {
  return {
    code: tier.code,
    priceInr: tier.priceInr,
    credits: tier.credits,
    windowDays: tier.windowDays,
    validityDays: tier.validityDays ?? null,
    price: {
      taxablePaise: priceLine.taxablePaise,
      gstPaise: priceLine.gstPaise,
      roundOffPaise: priceLine.roundOffPaise,
      totalPaise: priceLine.totalPaise,
      gstRateBps: priceLine.gstRateBps,
      display: formatGstPriceLine(priceLine),
    },
  };
}

/**
 * The config-driven Pricing Engine surface (ADR-0013 Decision A). Ops edit the
 * catalog VALUES here; `@badabhai/pricing` owns the SHAPE + the deterministic
 * fail-closed math. The engine NEVER serves an unvalidated/negative price — an
 * invalid stored row falls back to the typed default and is surfaced as
 * `source:"default"` (not silently). No LLM, PII-free (codes + integer ₹ only).
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    private readonly repo: PricingRepository,
    private readonly events: EventsService,
    // #2749 item 11 — RETIRED_PRODUCTS_OFF_SALE, read through `retired-products.ts` only.
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<ServerConfig, "RETIRED_PRODUCTS_OFF_SALE">,
  ) {}

  /** Load + validate the active catalog, failing closed to the typed default. */
  async getActiveCatalog(): Promise<ActiveCatalog> {
    const row = await this.repo.getActive();
    if (!row) {
      return { catalog: DEFAULT_CATALOG, revision: 0, source: "default" };
    }
    const parsed = safeParseCatalog(row.catalog);
    if (!parsed.ok) {
      // A stored row that fails validation is NEVER served — fail closed to default
      // and make it loud (ops + logs), but keep pricing working.
      this.logger.error(
        `active pricing_catalog revision=${row.revision} FAILED validation; serving the typed default (fail-closed)`,
      );
      return { catalog: DEFAULT_CATALOG, revision: row.revision, source: "default" };
    }
    return { catalog: parsed.catalog, revision: row.revision, source: "db" };
  }

  /**
   * The payer catalog read (`GET /payer/pricing/catalog`): the active catalog's products plus
   * each tier's effective charge price at `now` (#2085). Every tier is priced through
   * {@link chargeQuote}, the charge paths' own function — so shown == charged by construction.
   *
   * CREDIT PACKS (#2749): only `contact_unlock`, the one product `PaymentGateway.resolvePack`
   * sells, and only its tiers {@link creditPackSale} calls sellable now — the SAME answer the
   * purchase path acts on. Anything else (another credit-pack product, an off-sale tier, every
   * tier of a stored row that failed validation, a tier whose GST line cannot be computed) is
   * absent from BOTH `products` and `prices`, so nothing about it reaches a payer. A sellable
   * tier is rebuilt from a whitelist with its GST price line. Every payer (employer or agency)
   * reads this same method with no payer input, so all see the same packs at the same prices
   * (B2-48).
   *
   * The GST `price` on each pack is what a purchase of it charges (#2749 PR 3; see
   * {@link PayerPackPrice}): the order total equals `price.totalPaise`.
   *
   * RETIRED PRODUCTS (#2749 item 11): while `RETIRED_PRODUCTS_OFF_SALE` is on, every product kind
   * but the credit pack (posting plans, boosts, capacity, quota top-ups) is left out of BOTH
   * `products` and `prices` — the same switch that makes their purchase routes 404. So the
   * catalogue then lists credit packs only, and no offer can reach a payer (a credit pack's
   * `prices[].offer` is always null: it is charged at list price).
   *
   * Read-only, emits no event.
   */
  async getPayerCatalog(now: Date = new Date()): Promise<PayerCatalogView> {
    const active = await this.getActiveCatalog();
    const { catalog, revision, source } = active;
    const products: PayerProduct[] = [];
    const prices: PayerTierPrice[] = [];
    const priceRow = (productCode: string, tierCode: string, quote: Quote): PayerTierPrice => {
      const offer = quote.offerApplied
        ? catalog.offers.find((o) => o.code === quote.offerApplied)
        : undefined;
      return {
        product_code: productCode,
        tier_code: tierCode,
        base_price_inr: quote.basePriceInr,
        price_inr: quote.finalInr,
        discount_inr: quote.discountInr,
        offer: offer ? { code: offer.code, ends_at: new Date(offer.until).toISOString() } : null,
      };
    };
    const charge = (productCode: string, tierCode: string): Quote | null => {
      const result = chargeQuote(catalog, { productCode, tierCode, now });
      // `!ok` is unreachable for a catalog tier; never invent a price.
      return result.ok ? result.quote : null;
    };

    for (const product of catalog.products) {
      // #2749 item 11 — a retired kind is not shown: no product, no price row.
      if (isProductKindOffSale(this.config, product.kind)) continue;
      // #2751 item 10 — Managed Hiring is NEVER in the payer catalogue: an agency or contractor
      // account must not be served it, and every other company reads it from the Managed Hiring
      // quote (the tier is decided from the job, behind MANAGED_HIRING_ROLLOUT).
      if (product.kind === "managed_hiring") continue;
      if (product.kind === "credit_pack") {
        // Shown only if sold: resolvePack sells `contact_unlock` alone.
        if (product.code !== CREDIT_PACK_PRODUCT) continue;
        const tiers: PayerCreditPackTier[] = [];
        for (const tier of product.tiers) {
          const sale = creditPackSale(active, tier, now);
          if (!sale.sellable) {
            // One bad tier must not take the catalogue down for every payer: skip it, loudly.
            if (sale.reason === "gst_error") {
              this.logger.warn(
                `credit pack skipped: GST line failed pack=${tier.code} error=${sale.errorClass}`,
              );
            }
            continue; // hidden: no tier, no price row
          }
          tiers.push(toPayerCreditPackTier(sale.pack));
          prices.push(priceRow(product.code, tier.code, sale.pack.quote));
        }
        // Nothing sellable → the product is left out: an empty tier list would fail the shared
        // `productSchema` (tiers.min(1)) that payer-web parses this response with.
        if (tiers.length > 0) products.push({ kind: "credit_pack", code: product.code, tiers });
        continue;
      }
      products.push(product); // unchanged while on sale (#2749 item 11 retires these kinds)
      for (const tier of product.tiers) {
        const quote = charge(product.code, tier.code);
        if (quote) prices.push(priceRow(product.code, tier.code, quote));
      }
    }
    return { revision, source, products, prices, priced_at: now.toISOString() };
  }

  /**
   * Preview a resolved price. NOTE: this is a PREVIEW — coupon usage caps are
   * enforced at PURCHASE time (the plan/boost stream reads the real redemption
   * counts); the preview resolves with zero recorded usage.
   */
  async quote(query: QuoteQueryDto): Promise<ResolveResult> {
    const { catalog } = await this.getActiveCatalog();
    return resolvePrice(catalog, {
      productCode: query.product,
      tierCode: query.tier,
      couponCode: query.coupon,
    });
  }

  /**
   * Publish a new catalog revision (ops config-builder write). The DTO already
   * validated the catalog via `catalogSchema`; we re-validate via `safeParseCatalog`
   * for the fail-closed guarantee, then publish atomically and emit the PII-free
   * `pricing.changed` audit event (field KEYS only — never old/new values).
   */
  async updateCatalog(dto: UpdateCatalogDto, ctx: RequestContext): Promise<ActiveCatalog> {
    const parsed = safeParseCatalog(dto.catalog);
    if (!parsed.ok) {
      // Should be unreachable (DTO already validated), but never store an invalid catalog.
      throw new Error("pricing catalog failed validation");
    }
    const current = await this.repo.getActive();
    const nextRevision = (current?.revision ?? 0) + 1;
    const row = await this.repo.publish({
      catalog: dto.catalog as Catalog,
      revision: nextRevision,
      updatedBy: dto.updated_by,
    });

    const payload: PayloadInputOf<"pricing.changed"> = {
      change_type: dto.change.change_type,
      entity_code: dto.change.entity_code,
      changed_fields: dto.change.changed_fields,
      changed_by: dto.updated_by,
    };
    await this.events.emit({
      event_name: "pricing.changed",
      actor: { actor_type: "ops", actor_id: dto.updated_by },
      subject: { subject_type: "pricing_plan", subject_id: row.id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { catalog: parsed.catalog, revision: row.revision, source: "db" };
  }
}

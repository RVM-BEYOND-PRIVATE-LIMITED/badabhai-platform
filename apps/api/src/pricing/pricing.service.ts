import { Injectable, Logger } from "@nestjs/common";
import {
  safeParseCatalog,
  resolvePrice,
  DEFAULT_CATALOG,
  type Catalog,
  type Product,
  type ResolveResult,
} from "@badabhai/pricing";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PricingRepository } from "./pricing.repository";
import type { UpdateCatalogDto, QuoteQueryDto } from "./pricing.dto";
import { chargeQuote } from "./charge-price";

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
 * The payer-facing catalog projection (D-6 + #2085). `products` is unchanged (the catalog's
 * priced products). `prices` + `priced_at` are ADDITIVE: the effective per-tier charge price
 * and the active offer behind it. Coupons, coupon caps and `floorPriceInr` never ship.
 */
export interface PayerCatalogView {
  readonly revision: number;
  readonly source: "db" | "default";
  readonly products: readonly Product[];
  readonly prices: readonly PayerTierPrice[];
  /** The instant `prices` were resolved at (ISO-8601). An offer window can close after it. */
  readonly priced_at: string;
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
   * Read-only, emits no event.
   */
  async getPayerCatalog(now: Date = new Date()): Promise<PayerCatalogView> {
    const { catalog, revision, source } = await this.getActiveCatalog();
    const prices: PayerTierPrice[] = [];
    for (const product of catalog.products) {
      for (const tier of product.tiers) {
        const result = chargeQuote(catalog, { productCode: product.code, tierCode: tier.code, now });
        if (!result.ok) continue; // unreachable for a catalog tier; never invent a price
        const { quote } = result;
        const offer = quote.offerApplied
          ? catalog.offers.find((o) => o.code === quote.offerApplied)
          : undefined;
        prices.push({
          product_code: product.code,
          tier_code: tier.code,
          base_price_inr: quote.basePriceInr,
          price_inr: quote.finalInr,
          discount_inr: quote.discountInr,
          offer: offer ? { code: offer.code, ends_at: new Date(offer.until).toISOString() } : null,
        });
      }
    }
    return { revision, source, products: catalog.products, prices, priced_at: now.toISOString() };
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

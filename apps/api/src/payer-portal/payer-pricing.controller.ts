import { Controller, Get, UseGuards } from "@nestjs/common";
import type { Product } from "@badabhai/pricing";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { PricingService } from "../pricing/pricing.service";

/**
 * The payer-facing catalog projection (D-6): the PRICED PRODUCTS only.
 *
 * Deliberately NOT the full ops `ActiveCatalog`: `offers`/`coupons` are ops promo
 * config (coupon codes + usage caps) the portal renders nowhere — least exposure —
 * and `floorPriceInr` is resolve-engine internals. `revision`/`source` ride along
 * as provenance (source:"default" = the engine failed closed to the typed default,
 * which is STILL what the server would charge, so the portal may render it as live).
 * PII-free by construction (ADR-0013 §A.3: codes + integer ₹ + counts/days only).
 */
export interface PayerCatalogView {
  readonly revision: number;
  readonly source: "db" | "default";
  readonly products: readonly Product[];
}

/**
 * Payer-facing READ-ONLY pricing surface (context-drift D-6).
 *
 * WHY THIS EXISTS: apps/payer-web used to render prices from the COMPILE-TIME
 * `DEFAULT_CATALOG`, so an ops catalog edit (PUT /pricing/catalog) never reached the
 * portal without a rebuild. The portal now reads THIS route for the live catalog.
 *
 * WHY NOT the existing `GET /pricing/catalog`: that controller is ops-intent (the
 * ADR-0013 config builder — its comment slates a PricingAdminGuard launch gate, which
 * would break an external consumer), and it returns the FULL catalog incl. coupons.
 *
 * AUTH: {@link PayerAuthGuard} — pricing tiers are not secret, but every payer-web
 * data fetch rides the payer session Bearer (the portal's one transport pattern,
 * XB-A), and the only public `/payer/*` routes are the auth boundary itself.
 *
 * Read-only view of config — no event (matches the sibling payer reads: ownCapacity,
 * ownCredits). All logic + the fail-closed catalog handling stay in PricingService.
 */
@Controller("payer/pricing")
@UseGuards(PayerAuthGuard)
export class PayerPricingController {
  constructor(private readonly pricing: PricingService) {}

  /** The active catalog's products (validated, fail-closed server-side) for price DISPLAY. */
  @Get("catalog")
  async getCatalog(): Promise<PayerCatalogView> {
    const { catalog, revision, source } = await this.pricing.getActiveCatalog();
    return { revision, source, products: catalog.products };
  }
}

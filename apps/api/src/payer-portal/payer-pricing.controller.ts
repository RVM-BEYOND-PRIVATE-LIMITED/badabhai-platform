import { Controller, Get, UseGuards } from "@nestjs/common";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { PricingService, type PayerCatalogView } from "../pricing/pricing.service";

export type { PayerCatalogView, PayerTierPrice } from "../pricing/pricing.service";

/**
 * Payer-facing READ-ONLY pricing surface (context-drift D-6, extended by #2085).
 *
 * WHY THIS EXISTS: apps/payer-web used to render prices from the COMPILE-TIME
 * `DEFAULT_CATALOG`, so an ops catalog edit (PUT /pricing/catalog) never reached the
 * portal without a rebuild. The portal now reads THIS route for the live catalog.
 *
 * WHAT IT RETURNS: the priced PRODUCTS (unchanged since D-6) plus, since #2085, `prices` —
 * each tier's EFFECTIVE charge price and the active automatic offer behind it, computed by
 * the same function every purchase route charges through, so the dialog can show what the
 * purchase will actually take. Coupons (codes + usage caps) and `floorPriceInr` never ship:
 * a coupon is a code the payer types, not something to advertise. `revision`/`source` ride
 * along as provenance (source:"default" = the engine failed closed to the typed default,
 * which is STILL what the server would charge, so the portal may render it as live).
 * PII-free by construction (ADR-0013 §A.3: codes + integer ₹ + counts/days only).
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

  /** The active catalog's products + each tier's effective charge price, for price DISPLAY. */
  @Get("catalog")
  getCatalog(): Promise<PayerCatalogView> {
    return this.pricing.getPayerCatalog();
  }
}

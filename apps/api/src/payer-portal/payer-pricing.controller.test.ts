import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import { PayerPricingController } from "./payer-pricing.controller";
import { PayerAuthGuard } from "../payers/payer-auth.guard";

/**
 * Payer-facing catalog read (context-drift D-6) — the projection contract.
 *
 * The portal renders LIVE prices from this route, so pin:
 *  - it serves the ACTIVE catalog from PricingService.getActiveCatalog() (the one
 *    fail-closed engine — an ops edit reaches payers with NO portal rebuild);
 *  - the response is the PRODUCTS-ONLY projection: never offers/coupons (ops promo
 *    config — coupon codes/caps must not ship to every payer) nor floorPriceInr;
 *  - the route is behind PayerAuthGuard (the portal's one authed-fetch pattern).
 */
describe("PayerPricingController — GET /payer/pricing/catalog (D-6 live-pricing read)", () => {
  interface ActiveStub {
    catalog: typeof DEFAULT_CATALOG;
    revision: number;
    source: "db" | "default";
  }
  function makeCtrl(
    active: ActiveStub = { catalog: DEFAULT_CATALOG, revision: 3, source: "db" },
  ) {
    const pricing = { getActiveCatalog: vi.fn(async () => active) };
    return { ctrl: new PayerPricingController(pricing as never), pricing };
  }

  it("serves the ACTIVE catalog's products + provenance from the one pricing engine", async () => {
    const { ctrl, pricing } = makeCtrl();
    const res = await ctrl.getCatalog();
    expect(pricing.getActiveCatalog).toHaveBeenCalledTimes(1);
    expect(res.revision).toBe(3);
    expect(res.source).toBe("db");
    expect(res.products).toBe(DEFAULT_CATALOG.products);
  });

  it("NEVER leaks offers/coupons/floorPriceInr (products-only projection)", async () => {
    const { ctrl } = makeCtrl();
    const res = await ctrl.getCatalog();
    expect(Object.keys(res).sort()).toEqual(["products", "revision", "source"]);
    expect(JSON.stringify(res)).not.toMatch(/coupon|offer|floorPriceInr|totalUsageCap/);
  });

  /**
   * LOW-3: the catalog-LEVEL pin above cannot see a NEW TIER FIELD (products are projected
   * whole, so a field added to a tier schema ships to payers by default). Pin the tier keys
   * per product kind: adding one fails HERE, forcing a deliberate "is this payer-visible?"
   * call rather than a silent exposure. `packages/pricing/types.ts` carries the same warning.
   */
  it("pins the exact TIER keys shipped per product kind (a new tier field must be deliberate)", async () => {
    const { ctrl } = makeCtrl();
    const { products } = await ctrl.getCatalog();
    const keysFor = (kind: string): string[] => {
      const product = products.find((p) => p.kind === kind);
      expect(product, `default catalog must carry a ${kind} product`).toBeDefined();
      return Object.keys(product!.tiers[0]!).sort();
    };
    expect(keysFor("posting")).toEqual([
      "applicantVisibilityQuota",
      "code",
      "priceInr",
      "validityDays",
    ]);
    expect(keysFor("boost")).toEqual(["boostDays", "code", "priceInr"]);
    expect(keysFor("credit_pack")).toEqual(["code", "credits", "priceInr", "windowDays"]);
    expect(keysFor("capacity")).toEqual([
      "code",
      "maxActiveVacancies",
      "priceInr",
      "validityDays",
    ]);
    expect(keysFor("quota_topup")).toEqual(["additionalVisibilityQuota", "code", "priceInr"]);
  });

  it("passes through the fail-closed default provenance (source:'default' stays visible)", async () => {
    const { ctrl } = makeCtrl({ catalog: DEFAULT_CATALOG, revision: 0, source: "default" });
    const res = await ctrl.getCatalog();
    expect(res.source).toBe("default");
    expect(res.products.length).toBeGreaterThan(0);
  });

  it("is class-guarded by PayerAuthGuard (the payer-web transport is Bearer-authed)", () => {
    const guards =
      (Reflect.getMetadata("__guards__", PayerPricingController) as unknown[] | undefined) ?? [];
    expect(guards).toContain(PayerAuthGuard);
  });
});

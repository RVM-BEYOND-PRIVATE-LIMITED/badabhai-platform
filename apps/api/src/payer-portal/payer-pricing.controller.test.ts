import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CATALOG, parseCatalog, type Catalog } from "@badabhai/pricing";
import { PayerPricingController } from "./payer-pricing.controller";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { PricingService } from "../pricing/pricing.service";
import { PaymentGateway } from "../unlocks/payment-gateway";

/**
 * Payer-facing catalog read (context-drift D-6, extended by #2085) — the projection contract.
 *
 * The portal renders LIVE prices from this route, so pin:
 *  - it serves the ACTIVE catalog through PricingService (the one fail-closed engine — an ops
 *    edit reaches payers with NO portal rebuild);
 *  - `products` is the unchanged D-6 projection, and `prices` (#2085, additive) is each tier's
 *    effective CHARGE price + the active automatic offer — never a coupon, a coupon cap or
 *    `floorPriceInr`;
 *  - the route is behind PayerAuthGuard (the portal's one authed-fetch pattern).
 *
 * These drive the REAL PricingService over a stubbed repository row, so the controller and the
 * projection are tested together rather than the controller against a double of itself.
 */
describe("PayerPricingController — GET /payer/pricing/catalog (D-6 + #2085)", () => {
  /** `null` = no stored row (the engine fails closed to the typed default). */
  function makeCtrl(row: { catalog: unknown; revision: number } | null = {
    catalog: DEFAULT_CATALOG,
    revision: 3,
  }) {
    const getActive = vi.fn().mockResolvedValue(row ?? undefined);
    const pricing = new PricingService({ getActive } as never, { emit: vi.fn() } as never);
    return { ctrl: new PayerPricingController(pricing), getActive, pricing };
  }

  const OFFER_UNTIL = "2099-01-01T00:00:00.000Z";
  const withOffers = (offers: unknown[], coupons: unknown[] = []): Catalog =>
    parseCatalog({ ...DEFAULT_CATALOG, offers, coupons });

  it("serves the ACTIVE catalog's products + provenance from the one pricing engine", async () => {
    const { ctrl, getActive } = makeCtrl();
    const res = await ctrl.getCatalog();
    expect(getActive).toHaveBeenCalledTimes(1);
    expect(res.revision).toBe(3);
    expect(res.source).toBe("db");
    expect(res.products).toEqual(DEFAULT_CATALOG.products);
  });

  it("the top-level keys are the D-6 ones plus the additive #2085 `prices` + `priced_at`", async () => {
    const { ctrl } = makeCtrl();
    const res = await ctrl.getCatalog();
    expect(Object.keys(res).sort()).toEqual(["priced_at", "prices", "products", "revision", "source"]);
    expect(Number.isNaN(Date.parse(res.priced_at))).toBe(false);
  });

  it("with no offer live, every tier is priced and price == list price (offer null)", async () => {
    const { ctrl } = makeCtrl();
    const { products, prices } = await ctrl.getCatalog();
    const tierCount = products.reduce((n, p) => n + p.tiers.length, 0);
    expect(prices).toHaveLength(tierCount);
    for (const p of prices) {
      expect(p.price_inr).toBe(p.base_price_inr);
      expect(p.discount_inr).toBe(0);
      expect(p.offer).toBeNull();
    }
    expect(prices.find((p) => p.tier_code === "cap_5")).toEqual({
      product_code: "hiring_capacity",
      tier_code: "cap_5",
      base_price_inr: 5000,
      price_inr: 5000,
      discount_inr: 0,
      offer: null,
    });
  });

  it("an ACTIVE offer shows its price, code and expiry on exactly the tiers it scopes", async () => {
    const { ctrl } = makeCtrl({
      catalog: withOffers([
        {
          code: "cap_launch",
          scope: { productCode: "hiring_capacity", tierCode: "cap_5" },
          kind: "flat",
          value: 1000,
          from: "2026-01-01T00:00:00.000Z",
          until: OFFER_UNTIL,
        },
      ]),
      revision: 4,
    });
    const { prices } = await ctrl.getCatalog();
    expect(prices.find((p) => p.tier_code === "cap_5")).toMatchObject({
      base_price_inr: 5000,
      price_inr: 4000,
      discount_inr: 1000,
      offer: { code: "cap_launch", ends_at: OFFER_UNTIL },
    });
    expect(prices.find((p) => p.tier_code === "cap_15")).toMatchObject({ price_inr: 12000, offer: null });
  });

  it("an EXPIRED or not-yet-started offer is not shown (the charge would not apply it either)", async () => {
    const { ctrl } = makeCtrl({
      catalog: withOffers([
        {
          code: "old",
          scope: { productCode: "job_posting" },
          kind: "percent",
          value: 50,
          from: "2020-01-01T00:00:00.000Z",
          until: "2020-02-01T00:00:00.000Z",
        },
        {
          code: "future",
          scope: { productCode: "job_posting" },
          kind: "percent",
          value: 50,
          from: "2098-01-01T00:00:00.000Z",
          until: OFFER_UNTIL,
        },
      ]),
      revision: 5,
    });
    const { prices } = await ctrl.getCatalog();
    for (const p of prices.filter((x) => x.product_code === "job_posting")) {
      expect(p.offer).toBeNull();
      expect(p.price_inr).toBe(p.base_price_inr);
    }
  });

  it("a credit-pack offer is NOT advertised, because the credit-pack charge does not apply it", async () => {
    const catalog = withOffers([
      {
        code: "packs_half",
        scope: { productCode: "contact_unlock" },
        kind: "percent",
        value: 50,
        from: "2026-01-01T00:00:00.000Z",
        until: OFFER_UNTIL,
      },
    ]);
    const { ctrl, pricing } = makeCtrl({ catalog, revision: 6 });
    const shown = (await ctrl.getCatalog()).prices.find((p) => p.tier_code === "pack_50")!;
    expect(shown).toMatchObject({ price_inr: 2000, offer: null });

    // ...and shown == charged on the credit-pack path, through the same function.
    const gw = new PaymentGateway(
      { creditPack: vi.fn() } as never,
      { PAYMENTS_ENABLE_REAL: false } as never,
      pricing,
      { isLive: false, keyId: null } as never,
    );
    expect((await gw.resolvePack("pack_50"))!.priceInr).toBe(shown.price_inr);
  });

  it("NEVER leaks coupons, coupon caps or floorPriceInr", async () => {
    const { ctrl } = makeCtrl({
      catalog: withOffers(
        [],
        [
          {
            code: "secret10",
            scope: { productCode: "job_posting" },
            kind: "percent",
            value: 10,
            from: "2026-01-01T00:00:00.000Z",
            until: OFFER_UNTIL,
            totalUsageCap: 100,
            perPayerLimit: 1,
          },
        ],
      ),
      revision: 7,
    });
    const body = JSON.stringify(await ctrl.getCatalog());
    expect(body).not.toMatch(/coupon|secret10|floorPriceInr|totalUsageCap|perPayerLimit/);
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

  it("pins the exact keys of one `prices` entry (a new field must be deliberate)", async () => {
    const { ctrl } = makeCtrl();
    const { prices } = await ctrl.getCatalog();
    expect(Object.keys(prices[0]!).sort()).toEqual([
      "base_price_inr",
      "discount_inr",
      "offer",
      "price_inr",
      "product_code",
      "tier_code",
    ]);
  });

  it("passes through the fail-closed default provenance (source:'default' stays visible)", async () => {
    const { ctrl } = makeCtrl(null);
    const res = await ctrl.getCatalog();
    expect(res.source).toBe("default");
    expect(res.products.length).toBeGreaterThan(0);
    expect(res.prices.length).toBeGreaterThan(0);
  });

  it("is class-guarded by PayerAuthGuard (the payer-web transport is Bearer-authed)", () => {
    const guards =
      (Reflect.getMetadata("__guards__", PayerPricingController) as unknown[] | undefined) ?? [];
    expect(guards).toContain(PayerAuthGuard);
  });
});

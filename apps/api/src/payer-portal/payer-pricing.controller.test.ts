import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import {
  DEFAULT_CATALOG,
  formatPackPriceLine,
  gstPriceLine,
  parseCatalog,
  type Catalog,
  type CreditPackTier,
} from "@badabhai/pricing";
import {
  PayerPricingController,
  type PayerCreditPackProduct,
  type PayerProduct,
} from "./payer-pricing.controller";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { PricingService } from "../pricing/pricing.service";
import { PaymentGateway } from "../unlocks/payment-gateway";

/** The credit-pack product of a payer catalogue view, if it has one. */
const creditPackOf = (products: readonly PayerProduct[]): PayerCreditPackProduct | undefined =>
  products.find((p): p is PayerCreditPackProduct => p.kind === "credit_pack");

/** DEFAULT_CATALOG with its `contact_unlock` tiers replaced (parsed, like a stored row). */
const withPackTiers = (tiers: CreditPackTier[]): Catalog =>
  parseCatalog({
    ...DEFAULT_CATALOG,
    products: DEFAULT_CATALOG.products.map((p) => (p.kind === "credit_pack" ? { ...p, tiers } : p)),
  });

/** The brief's packs (#2749) as a stored row would carry them, Annual held until 1 Apr 2027. */
const BRIEF_TIERS: CreditPackTier[] = [
  { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14, validityDays: 30 },
  { code: "pack_standard", priceInr: 1599, credits: 40, windowDays: 14, validityDays: 60 },
  { code: "pack_big", priceInr: 2999, credits: 100, windowDays: 14, validityDays: 90 },
  {
    code: "pack_annual",
    priceInr: 9999,
    credits: 360,
    windowDays: 14,
    validityDays: 365,
    onSaleFrom: "2027-04-01",
  },
];

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
    const pricing = new PricingService({ getActive } as never, { emit: vi.fn() } as never, {
      RETIRED_PRODUCTS_OFF_SALE: false,
    });
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
    // Every non-credit-pack product ships exactly as the catalog holds it (#2749 item 11 is later).
    expect(res.products.filter((p) => p.kind !== "credit_pack")).toEqual(
      DEFAULT_CATALOG.products.filter((p) => p.kind !== "credit_pack"),
    );
    // Credit packs are projected (#2749): same codes, prices, credits and window, in order.
    const packs = creditPackOf(res.products)!;
    const source = DEFAULT_CATALOG.products.find((p) => p.kind === "credit_pack")!;
    expect(packs.code).toBe(source.code);
    expect(
      packs.tiers.map(({ code, priceInr, credits, windowDays }) => ({
        code,
        priceInr,
        credits,
        windowDays,
      })),
    ).toEqual(source.tiers);
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
    // #2749: the credit-pack tier is a WHITELIST — `price` and `validityDays` are deliberate;
    // `onSaleFrom` / `offered` are never on it.
    expect(keysFor("credit_pack")).toEqual([
      "code",
      "credits",
      "price",
      "priceInr",
      "validityDays",
      "windowDays",
    ]);
    const pack = creditPackOf(products)!.tiers[0]!;
    expect(Object.keys(pack.price).sort()).toEqual([
      "display",
      "gstPaise",
      "gstRateBps",
      "roundOffPaise",
      "taxablePaise",
      "totalPaise",
    ]);
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

describe("GET /payer/pricing/catalog — credit packs on sale only, with GST (#2749)", () => {
  /** A controller over a stored row holding `tiers` as its packs. */
  function makeCtrl(tiers: CreditPackTier[]) {
    const getActive = vi.fn().mockResolvedValue({ catalog: withPackTiers(tiers), revision: 9 });
    const pricing = new PricingService({ getActive } as never, { emit: vi.fn() } as never, {
      RETIRED_PRODUCTS_OFF_SALE: false,
    });
    return { ctrl: new PayerPricingController(pricing), pricing };
  }
  const BEFORE_ANNUAL = new Date("2027-03-31T18:29:59Z");
  const ANNUAL_ON_SALE = new Date("2027-03-31T18:30:00Z");

  it("a pack with a FUTURE onSaleFrom is absent — from products, prices and the whole body", async () => {
    const { pricing } = makeCtrl(BRIEF_TIERS);
    const view = await pricing.getPayerCatalog(BEFORE_ANNUAL);
    expect(creditPackOf(view.products)!.tiers.map((t) => t.code)).toEqual([
      "pack_starter",
      "pack_standard",
      "pack_big",
    ]);
    expect(view.prices.map((p) => p.tier_code)).not.toContain("pack_annual");
    // Nothing about the hidden pack ships: not its code, price, credits or date.
    expect(JSON.stringify(view)).not.toMatch(/pack_annual|9999|2027-04-01|onSaleFrom|offered/);
  });

  it("the same pack is listed from 00:00 IST on its date (the IST boundary)", async () => {
    const { pricing } = makeCtrl(BRIEF_TIERS);
    const view = await pricing.getPayerCatalog(ANNUAL_ON_SALE);
    const annual = creditPackOf(view.products)!.tiers.find((t) => t.code === "pack_annual");
    expect(annual).toMatchObject({ priceInr: 9999, credits: 360, validityDays: 365 });
    expect(annual!.price.display).toBe("₹9,999 plus GST (₹11,799)");
    expect(view.prices.find((p) => p.tier_code === "pack_annual")).toMatchObject({
      price_inr: 9999,
    });
    // Its date still never ships, now that it is on sale.
    expect(JSON.stringify(view)).not.toMatch(/onSaleFrom|offered|2027-04-01/);
  });

  it("an offered:false pack is absent, whatever the date", async () => {
    const { ctrl } = makeCtrl([
      { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14 },
      { code: "pack_retired", priceInr: 1234, credits: 12, windowDays: 14, offered: false },
    ]);
    const res = await ctrl.getCatalog();
    expect(creditPackOf(res.products)!.tiers.map((t) => t.code)).toEqual(["pack_50"]);
    expect(JSON.stringify(res)).not.toMatch(/pack_retired|1234|offered/);
  });

  it("a credit-pack product with NOTHING on sale is left out (an empty tier list fails productSchema)", async () => {
    const { ctrl } = makeCtrl([
      { code: "pack_retired", priceInr: 1234, credits: 12, windowDays: 14, offered: false },
    ]);
    const res = await ctrl.getCatalog();
    expect(creditPackOf(res.products)).toBeUndefined();
    expect(res.products.length).toBe(DEFAULT_CATALOG.products.length - 1);
    expect(res.prices.some((p) => p.product_code === "contact_unlock")).toBe(false);
  });

  it("an UNKNOWN or future tier field never leaks (the tier is a whitelist, not the stored object)", async () => {
    const { ctrl, pricing } = makeCtrl(BRIEF_TIERS);
    // Bypass the schema's own key-stripping: a field the catalogue schema may carry tomorrow
    // must still not ship unless the projection names it.
    const catalog = withPackTiers(BRIEF_TIERS);
    const packs = catalog.products.find((p) => p.kind === "credit_pack")!;
    (packs.tiers[0] as Record<string, unknown>).internalCostInr = 123;
    (packs.tiers[0] as Record<string, unknown>).supplierRef = "acct_secret";
    vi.spyOn(pricing, "getActiveCatalog").mockResolvedValue({ catalog, revision: 9, source: "db" });
    const body = JSON.stringify(await ctrl.getCatalog());
    expect(body).not.toMatch(/internalCostInr|supplierRef|acct_secret/);
  });

  it("each price line is the GST function's output for the charged price", async () => {
    const { ctrl } = makeCtrl(BRIEF_TIERS);
    const { products, prices } = await ctrl.getCatalog();
    const tiers = creditPackOf(products)!.tiers;
    expect(tiers.length).toBeGreaterThan(0);
    for (const tier of tiers) {
      const charged = prices.find((p) => p.tier_code === tier.code)!.price_inr;
      expect(charged).toBe(tier.priceInr); // credit packs: list price, no offer
      expect(tier.price).toEqual({
        ...gstPriceLine(charged),
        display: formatPackPriceLine(charged),
      });
    }
    // The brief's lines (B4C-06) and totals (the issue's table), in paise.
    const byCode = new Map(tiers.map((t) => [t.code, t]));
    expect(byCode.get("pack_starter")!.price).toEqual({
      taxablePaise: 99_900,
      gstPaise: 18_000,
      roundOffPaise: 0,
      totalPaise: 117_900,
      gstRateBps: 1800,
      display: "₹999 plus GST (₹1,179)",
    });
    expect(byCode.get("pack_standard")!.price.display).toBe("₹1,599 plus GST (₹1,887)");
    expect(byCode.get("pack_big")!.price.display).toBe("₹2,999 plus GST (₹3,539)");
    expect(byCode.get("pack_starter")!.validityDays).toBe(30);
    expect(byCode.get("pack_standard")!.validityDays).toBe(60);
    expect(byCode.get("pack_big")!.validityDays).toBe(90);
  });

  it("validityDays is null for a pack that sets none (every DEFAULT_CATALOG pack today)", async () => {
    const defaultPacks = DEFAULT_CATALOG.products.find((p) => p.kind === "credit_pack")!;
    const res = await makeCtrl(defaultPacks.tiers).ctrl.getCatalog();
    for (const tier of creditPackOf(res.products)!.tiers) {
      expect(tier.validityDays).toBeNull();
      expect(tier.windowDays).toBe(14); // the old access window, kept for older readers
    }
  });

  it("the response still parses with the shared productSchema payer-web reads it with", async () => {
    const { productSchema } = await import("@badabhai/pricing");
    const { products } = await makeCtrl(BRIEF_TIERS).ctrl.getCatalog();
    for (const product of products) expect(productSchema.safeParse(product).success).toBe(true);
  });

  /** A real PricingService over one repository row (`undefined` = no row, production today). */
  const serviceOver = (row: { catalog: unknown; revision: number } | undefined) =>
    new PricingService(
      { getActive: vi.fn().mockResolvedValue(row) } as never,
      { emit: vi.fn() } as never,
      { RETIRED_PRODUCTS_OFF_SALE: false },
    );
  const gatewayOver = (pricing: PricingService) =>
    new PaymentGateway(
      { creditPack: vi.fn() } as never,
      { PAYMENTS_ENABLE_REAL: false } as never,
      pricing,
      { isLive: false, keyId: null } as never,
    );
  const HUGE: CreditPackTier = {
    code: "pack_huge",
    priceInr: 9_999_999_999,
    credits: 1,
    windowDays: 14,
  };
  /** DEFAULT_CATALOG plus a SECOND credit-pack product, which the purchase path does not sell. */
  const withSecondPackProduct = (): Catalog =>
    parseCatalog({
      ...DEFAULT_CATALOG,
      products: [
        ...DEFAULT_CATALOG.products,
        {
          kind: "credit_pack",
          code: "bulk_unlock",
          tiers: [{ code: "pack_bulk", priceInr: 4321, credits: 99, windowDays: 14 }],
        },
      ],
    });

  it("#2749: with NO stored row (production today) the DEFAULT packs are listed as before", async () => {
    const view = await serviceOver(undefined).getPayerCatalog();
    expect(view).toMatchObject({ source: "default", revision: 0 });
    expect(creditPackOf(view.products)!.tiers.map((t) => t.code)).toEqual([
      "pack_50",
      "pack_200",
      "pack_1000",
    ]);
  });

  it("#2749: a stored row that FAILS validation lists no packs — never the default ones", async () => {
    const view = await serviceOver({
      catalog: { version: 1, products: "broken" },
      revision: 12,
    }).getPayerCatalog();
    expect(view).toMatchObject({ source: "default", revision: 12 });
    expect(creditPackOf(view.products)).toBeUndefined();
    expect(view.prices.some((p) => p.product_code === "contact_unlock")).toBe(false);
    // Every other product still shows the default, which is what it would charge.
    expect(view.products).toEqual(DEFAULT_CATALOG.products.filter((p) => p.kind !== "credit_pack"));
  });

  it("#2749: a pack whose GST line cannot be computed is skipped and logged — not a 500 for everyone", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { ctrl } = makeCtrl([BRIEF_TIERS[0]!, HUGE]);
      const res = await ctrl.getCatalog();
      expect(creditPackOf(res.products)!.tiers.map((t) => t.code)).toEqual(["pack_starter"]);
      expect(res.prices.map((p) => p.tier_code)).not.toContain("pack_huge");
      expect(warn).toHaveBeenCalledWith(
        "credit pack skipped: GST line failed pack=pack_huge error=RangeError",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("#2749: only contact_unlock is shown — another credit-pack product is never listed", async () => {
    const view = await serviceOver({
      catalog: withSecondPackProduct(),
      revision: 5,
    }).getPayerCatalog();
    expect(view.products.filter((p) => p.kind === "credit_pack").map((p) => p.code)).toEqual([
      "contact_unlock",
    ]);
    expect(view.prices.some((p) => p.product_code === "bulk_unlock")).toBe(false);
    expect(JSON.stringify(view)).not.toMatch(/bulk_unlock|pack_bulk|4321/);
  });

  it.each([
    [
      "the brief's packs, before Annual's date",
      { catalog: withPackTiers(BRIEF_TIERS), revision: 9 },
      BEFORE_ANNUAL,
    ],
    [
      "the brief's packs, from Annual's date",
      { catalog: withPackTiers(BRIEF_TIERS), revision: 9 },
      ANNUAL_ON_SALE,
    ],
    ["no stored row (the default packs)", undefined, BEFORE_ANNUAL],
    [
      "a stored row that fails validation",
      { catalog: { version: 1, products: "broken" }, revision: 12 },
      BEFORE_ANNUAL,
    ],
    [
      "a pack whose GST line fails",
      { catalog: withPackTiers([BRIEF_TIERS[0]!, HUGE]), revision: 9 },
      BEFORE_ANNUAL,
    ],
    [
      "a second credit-pack product",
      { catalog: withSecondPackProduct(), revision: 5 },
      BEFORE_ANNUAL,
    ],
  ] as const)("shown == orderable: %s", async (_label, row, now) => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const pricing = serviceOver(row);
      const gw = gatewayOver(pricing);
      const shown = creditPackOf((await pricing.getPayerCatalog(now)).products)?.tiers ?? [];
      const candidates = [
        ...BRIEF_TIERS.map((t) => t.code),
        "pack_50",
        "pack_200",
        "pack_1000",
        "pack_10",
        "pack_25",
        "pack_huge",
        "pack_bulk",
      ];
      for (const code of candidates) {
        const listed = shown.find((t) => t.code === code);
        const orderable = await gw.resolvePack(code, now);
        expect(orderable === null, code).toBe(listed === undefined);
        if (listed) {
          expect(orderable).toMatchObject({ priceInr: listed.priceInr, credits: listed.credits });
        }
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("B2-48: an agency and an employer read the same packs at the same prices (no payer input)", () => {
    // The handler takes no argument — not the payer, not their role — and the route carries no
    // role guard, so every authenticated payer (employer or agent) gets the identical body.
    expect(PayerPricingController.prototype.getCatalog.length).toBe(0);
    expect(Reflect.getMetadata("__guards__", PayerPricingController)).toEqual([PayerAuthGuard]);
    expect(
      Reflect.getMetadata("__guards__", PayerPricingController.prototype.getCatalog),
    ).toBeUndefined();
  });
});

/**
 * #2749 item 11 (ADR-0065) — RETIRED_PRODUCTS_OFF_SALE and the payer catalogue (B4G-11/12).
 *
 * On: posting plans, boosts (the retired `all_candidates` tier included), hiring capacity and
 * quota top-ups are absent from `products` AND `prices`, and no offer reaches a payer. Credit
 * packs are untouched. Off (the default): the catalogue is exactly what it was.
 */
describe("GET /payer/pricing/catalog — the dropped products and their switch (#2749 item 11)", () => {
  const OFFER_UNTIL = "2099-01-01T00:00:00.000Z";
  /** DEFAULT_CATALOG plus an automatic offer on a plan tier and a coupon, as ops could store. */
  const WITH_OFFER = parseCatalog({
    ...DEFAULT_CATALOG,
    offers: [
      {
        code: "launch10",
        scope: { productCode: "job_posting", tierCode: "standard" },
        kind: "percent",
        value: 10,
        from: "2026-01-01T00:00:00.000Z",
        until: OFFER_UNTIL,
      },
    ],
    coupons: [
      {
        code: "welcome100",
        scope: { productCode: "job_boost" },
        kind: "flat",
        value: 100,
        from: "2026-01-01T00:00:00.000Z",
        until: OFFER_UNTIL,
        totalUsageCap: 100,
        perPayerLimit: 1,
      },
    ],
  });

  const catalogWith = async (retiredOffSale: boolean, catalog: Catalog = WITH_OFFER) => {
    const pricing = new PricingService(
      { getActive: vi.fn().mockResolvedValue({ catalog, revision: 4 }) } as never,
      { emit: vi.fn() } as never,
      { RETIRED_PRODUCTS_OFF_SALE: retiredOffSale },
    );
    return new PayerPricingController(pricing).getCatalog();
  };

  it("switch ON: only the credit pack is listed, in products and in prices", async () => {
    const view = await catalogWith(true);
    expect(view.products.map((p) => p.kind)).toEqual(["credit_pack"]);
    expect(new Set(view.prices.map((p) => p.product_code))).toEqual(new Set(["contact_unlock"]));
    // The packs themselves are exactly what the switch-off catalogue lists.
    const off = await catalogWith(false);
    expect(creditPackOf(view.products)).toEqual(creditPackOf(off.products));
    expect(view.prices).toEqual(off.prices.filter((p) => p.product_code === "contact_unlock"));
  });

  it("switch ON: no plan, boost (all_candidates included), capacity or top-up code, offer or coupon is anywhere in the body", async () => {
    const body = JSON.stringify(await catalogWith(true));
    for (const code of [
      "job_posting",
      "job_boost",
      "all_candidates",
      "boost_7",
      "hiring_capacity",
      "cap_5",
      "quota_topup",
      "topup_10",
      "launch10",
      "welcome100",
    ]) {
      expect(body, code).not.toContain(code);
    }
    // No price row carries an offer: credit packs are charged at list price.
    expect((await catalogWith(true)).prices.every((p) => p.offer === null)).toBe(true);
  });

  it("switch OFF (the default): every product and its offer ship exactly as before", async () => {
    const view = await catalogWith(false);
    expect(view.products.map((p) => p.kind)).toEqual(DEFAULT_CATALOG.products.map((p) => p.kind));
    const plan = view.prices.find(
      (p) => p.product_code === "job_posting" && p.tier_code === "standard",
    );
    expect(plan?.offer).toEqual({ code: "launch10", ends_at: OFFER_UNTIL });
    expect(view.prices.some((p) => p.tier_code === "all_candidates")).toBe(true);
    // A coupon never ships, switch or no switch.
    expect(JSON.stringify(view)).not.toContain("welcome100");
  });

  it("switch ON with no credit pack on sale: an empty catalogue, never a retired product as filler", async () => {
    const view = await catalogWith(
      true,
      withPackTiers([
        {
          code: "pack_later",
          priceInr: 999,
          credits: 20,
          windowDays: 14,
          onSaleFrom: "2099-01-01",
        },
      ]),
    );
    expect(view.products).toEqual([]);
    expect(view.prices).toEqual([]);
  });
});

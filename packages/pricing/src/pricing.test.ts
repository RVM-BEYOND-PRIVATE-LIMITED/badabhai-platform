import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOG,
  parseCatalog,
  resolvePrice,
  safeParseCatalog,
  type Catalog,
} from "./index";

/** A small valid catalog with one offer + one coupon, for discount tests. */
const NOW = new Date("2026-06-16T12:00:00.000Z");
const WINDOW = { from: "2026-06-01T00:00:00.000Z", until: "2026-12-31T00:00:00.000Z" };
const EXPIRED = { from: "2025-01-01T00:00:00.000Z", until: "2025-02-01T00:00:00.000Z" };

const baseCatalog: Catalog = parseCatalog({
  version: 1,
  floorPriceInr: 0,
  products: [
    {
      kind: "posting",
      code: "job_posting",
      tiers: [
        { code: "standard", priceInr: 1000, validityDays: 14, applicantVisibilityQuota: 10 },
        { code: "pro", priceInr: 2500, validityDays: 30, applicantVisibilityQuota: 30 },
      ],
    },
    { kind: "boost", code: "job_boost", tiers: [{ code: "all_candidates", priceInr: 1200, boostDays: 2 }] },
    {
      kind: "credit_pack",
      code: "contact_unlock",
      tiers: [
        { code: "pack_10", priceInr: 1000, credits: 10, windowDays: 14 },
        { code: "pack_25", priceInr: 2000, credits: 25, windowDays: 14 },
      ],
    },
    {
      kind: "capacity",
      code: "hiring_capacity",
      tiers: [
        { code: "cap_5", priceInr: 5000, maxActiveVacancies: 5, validityDays: 30 },
        { code: "cap_15", priceInr: 12000, maxActiveVacancies: 15, validityDays: 30 },
      ],
    },
  ],
  offers: [],
  coupons: [],
});

const ok = (r: ReturnType<typeof resolvePrice>) => {
  if (!r.ok) throw new Error("expected ok result");
  return r.quote;
};

describe("DEFAULT_CATALOG (the seed = absorbed credit-packs.ts + spec prices)", () => {
  it("validates and carries the maintainer-ratified prices", () => {
    const posting = DEFAULT_CATALOG.products.find((p) => p.code === "job_posting");
    expect(posting?.kind).toBe("posting");
    const std = ok(resolvePrice(DEFAULT_CATALOG, { productCode: "job_posting", tierCode: "standard", now: NOW }));
    expect(std.finalInr).toBe(1000);
    expect(std.grants).toEqual({ kind: "posting", validityDays: 14, applicantVisibilityQuota: 10 });
    const pro = ok(resolvePrice(DEFAULT_CATALOG, { productCode: "job_posting", tierCode: "pro", now: NOW }));
    expect(pro.finalInr).toBe(2500);
    expect(pro.grants).toEqual({ kind: "posting", validityDays: 30, applicantVisibilityQuota: 30 });
  });

  it("boost is ₹1200 / 2 days; packs match credit-packs.ts exactly", () => {
    const boost = ok(resolvePrice(DEFAULT_CATALOG, { productCode: "job_boost", tierCode: "all_candidates", now: NOW }));
    expect(boost.finalInr).toBe(1200);
    expect(boost.grants).toEqual({ kind: "boost", boostDays: 2 });
    const p10 = ok(resolvePrice(DEFAULT_CATALOG, { productCode: "contact_unlock", tierCode: "pack_10", now: NOW }));
    expect(p10).toMatchObject({ finalInr: 1000, grants: { kind: "credit_pack", credits: 10, windowDays: 14 } });
    const p25 = ok(resolvePrice(DEFAULT_CATALOG, { productCode: "contact_unlock", tierCode: "pack_25", now: NOW }));
    expect(p25).toMatchObject({ finalInr: 2000, grants: { kind: "credit_pack", credits: 25, windowDays: 14 } });
  });

  it("hiring_capacity tiers carry the maxActiveVacancies + validityDays grant (ADR-0016)", () => {
    const capacity = DEFAULT_CATALOG.products.find((p) => p.code === "hiring_capacity");
    expect(capacity?.kind).toBe("capacity");
    const cap5 = ok(resolvePrice(DEFAULT_CATALOG, { productCode: "hiring_capacity", tierCode: "cap_5", now: NOW }));
    expect(cap5).toMatchObject({ finalInr: 5000, kind: "capacity", grants: { kind: "capacity", maxActiveVacancies: 5, validityDays: 30 } });
    const cap15 = ok(resolvePrice(DEFAULT_CATALOG, { productCode: "hiring_capacity", tierCode: "cap_15", now: NOW }));
    expect(cap15).toMatchObject({ finalInr: 12000, grants: { kind: "capacity", maxActiveVacancies: 15, validityDays: 30 } });
  });
});

describe("capacity product (ADR-0016) — discount + fail-closed parity with the other kinds", () => {
  it("unknown capacity tier → unavailable (fail-closed, never a 0 price)", () => {
    expect(resolvePrice(baseCatalog, { productCode: "hiring_capacity", tierCode: "nope", now: NOW })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("applies a coupon to a capacity tier and still returns the capacity grant", () => {
    const cat = parseCatalog({
      ...baseCatalog,
      coupons: [
        {
          code: "capsave",
          scope: { productCode: "hiring_capacity", tierCode: "cap_5" },
          kind: "percent",
          value: 20,
          totalUsageCap: 100,
          perPayerLimit: 5,
          ...WINDOW,
        },
      ],
    });
    const q = ok(resolvePrice(cat, { productCode: "hiring_capacity", tierCode: "cap_5", couponCode: "capsave", now: NOW }));
    expect(q.finalInr).toBe(4000); // 5000 − 20%
    expect(q.couponApplied).toBe("capsave");
    expect(q.grants).toEqual({ kind: "capacity", maxActiveVacancies: 5, validityDays: 30 });
  });
});

describe("resolvePrice — unavailable (fail-closed, never a 0 price)", () => {
  it("unknown product → unavailable", () => {
    expect(resolvePrice(baseCatalog, { productCode: "nope", tierCode: "standard", now: NOW })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
  it("unknown tier → unavailable", () => {
    expect(resolvePrice(baseCatalog, { productCode: "job_posting", tierCode: "nope", now: NOW })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("offers (automatic, time-boxed)", () => {
  const withOffer = (offer: object): Catalog =>
    parseCatalog({ ...baseCatalog, offers: [offer] });

  it("applies an in-window percent offer", () => {
    const cat = withOffer({ code: "launch20", scope: { productCode: "job_posting", tierCode: "standard" }, kind: "percent", value: 20, ...WINDOW });
    const q = ok(resolvePrice(cat, { productCode: "job_posting", tierCode: "standard", now: NOW }));
    expect(q.finalInr).toBe(800);
    expect(q.discountInr).toBe(200);
    expect(q.offerApplied).toBe("launch20");
  });

  it("applies an in-window flat offer", () => {
    const cat = withOffer({ code: "flat300", scope: { productCode: "job_posting", tierCode: "pro" }, kind: "flat", value: 300, ...WINDOW });
    const q = ok(resolvePrice(cat, { productCode: "job_posting", tierCode: "pro", now: NOW }));
    expect(q.finalInr).toBe(2200);
    expect(q.offerApplied).toBe("flat300");
  });

  it("ignores an expired offer (full price, no offer)", () => {
    const cat = withOffer({ code: "old", scope: { productCode: "job_posting", tierCode: "standard" }, kind: "percent", value: 50, ...EXPIRED });
    const q = ok(resolvePrice(cat, { productCode: "job_posting", tierCode: "standard", now: NOW }));
    expect(q.finalInr).toBe(1000);
    expect(q.offerApplied).toBeNull();
  });

  it("ignores an out-of-scope offer", () => {
    const cat = withOffer({ code: "boostonly", scope: { productCode: "job_boost" }, kind: "percent", value: 50, ...WINDOW });
    const q = ok(resolvePrice(cat, { productCode: "job_posting", tierCode: "standard", now: NOW }));
    expect(q.finalInr).toBe(1000);
    expect(q.offerApplied).toBeNull();
  });

  it("picks the larger of two applicable offers, deterministically", () => {
    const cat = parseCatalog({
      ...baseCatalog,
      offers: [
        { code: "a_small", scope: { productCode: "job_posting" }, kind: "percent", value: 10, ...WINDOW },
        { code: "b_big", scope: { productCode: "job_posting" }, kind: "percent", value: 30, ...WINDOW },
      ],
    });
    const q = ok(resolvePrice(cat, { productCode: "job_posting", tierCode: "standard", now: NOW }));
    expect(q.offerApplied).toBe("b_big");
    expect(q.finalInr).toBe(700);
  });
});

describe("coupons (code-redeemed, fail-closed)", () => {
  const couponCat = (coupon: object): Catalog => parseCatalog({ ...baseCatalog, coupons: [coupon] });
  const SAVE = { code: "save15", scope: { productCode: "job_posting", tierCode: "standard" }, kind: "percent", value: 15, totalUsageCap: 100, perPayerLimit: 1, ...WINDOW };

  it("applies a valid coupon", () => {
    const q = ok(resolvePrice(couponCat(SAVE), { productCode: "job_posting", tierCode: "standard", couponCode: "save15", now: NOW }));
    expect(q.finalInr).toBe(850);
    expect(q.couponApplied).toBe("save15");
  });

  it("ignores an unknown coupon code (full price, no error)", () => {
    const q = ok(resolvePrice(couponCat(SAVE), { productCode: "job_posting", tierCode: "standard", couponCode: "ghost", now: NOW }));
    expect(q.finalInr).toBe(1000);
    expect(q.couponApplied).toBeNull();
  });

  it("ignores a coupon over its total usage cap", () => {
    const q = ok(resolvePrice(couponCat({ ...SAVE, totalUsageCap: 5 }), {
      productCode: "job_posting", tierCode: "standard", couponCode: "save15", now: NOW, couponUsage: { total: 5, perPayer: 0 },
    }));
    expect(q.couponApplied).toBeNull();
    expect(q.finalInr).toBe(1000);
  });

  it("ignores a coupon over the per-payer limit", () => {
    const q = ok(resolvePrice(couponCat(SAVE), {
      productCode: "job_posting", tierCode: "standard", couponCode: "save15", now: NOW, couponUsage: { total: 1, perPayer: 1 },
    }));
    expect(q.couponApplied).toBeNull();
  });

  it("ignores an expired coupon", () => {
    const q = ok(resolvePrice(couponCat({ ...SAVE, ...EXPIRED }), { productCode: "job_posting", tierCode: "standard", couponCode: "save15", now: NOW }));
    expect(q.couponApplied).toBeNull();
  });
});

describe("offer + coupon stack (at most one each, offer-then-coupon)", () => {
  it("applies offer first, then coupon on the running price", () => {
    const cat = parseCatalog({
      ...baseCatalog,
      offers: [{ code: "off20", scope: { productCode: "job_posting", tierCode: "standard" }, kind: "percent", value: 20, ...WINDOW }],
      coupons: [{ code: "cpn10", scope: { productCode: "job_posting", tierCode: "standard" }, kind: "percent", value: 10, totalUsageCap: 100, perPayerLimit: 5, ...WINDOW }],
    });
    const q = ok(resolvePrice(cat, { productCode: "job_posting", tierCode: "standard", couponCode: "cpn10", now: NOW }));
    // 1000 → −20% = 800 → −10% = 720
    expect(q.finalInr).toBe(720);
    expect(q.offerApplied).toBe("off20");
    expect(q.couponApplied).toBe("cpn10");
    expect(q.discountInr).toBe(280);
  });
});

describe("floor clamp — never negative", () => {
  it("a flat discount larger than base clamps to the floor (0), never negative", () => {
    const cat = parseCatalog({
      ...baseCatalog,
      offers: [{ code: "huge", scope: { productCode: "job_boost" }, kind: "flat", value: 5000, ...WINDOW }],
    });
    const q = ok(resolvePrice(cat, { productCode: "job_boost", tierCode: "all_candidates", now: NOW }));
    expect(q.finalInr).toBe(0);
    expect(q.finalInr).toBeGreaterThanOrEqual(0);
  });

  it("respects a non-zero catalog floor", () => {
    const cat = parseCatalog({
      ...baseCatalog,
      floorPriceInr: 500,
      offers: [{ code: "huge", scope: { productCode: "job_boost" }, kind: "flat", value: 5000, ...WINDOW }],
    });
    const q = ok(resolvePrice(cat, { productCode: "job_boost", tierCode: "all_candidates", now: NOW }));
    expect(q.finalInr).toBe(500);
  });
});

describe("determinism", () => {
  it("same (catalog, request) → identical quote", () => {
    const req = { productCode: "job_posting", tierCode: "pro", now: NOW } as const;
    expect(resolvePrice(baseCatalog, req)).toEqual(resolvePrice(baseCatalog, req));
  });
});

describe("safeParseCatalog — fail-closed gate", () => {
  it("valid raw → ok:true with the parsed catalog", () => {
    const res = safeParseCatalog(baseCatalog);
    expect(res.ok).toBe(true);
    expect(res.catalog.products.length).toBe(4);
  });

  it("a negative price is rejected → falls back to DEFAULT, ok:false", () => {
    const bad = { ...baseCatalog, products: [{ kind: "boost", code: "job_boost", tiers: [{ code: "x", priceInr: -5, boostDays: 2 }] }] };
    const res = safeParseCatalog(bad);
    expect(res.ok).toBe(false);
    expect(res.catalog).toBe(DEFAULT_CATALOG);
    expect(res.error).toBeTruthy();
  });

  it("garbage input → fails closed to DEFAULT", () => {
    expect(safeParseCatalog(null).ok).toBe(false);
    expect(safeParseCatalog({}).ok).toBe(false);
    expect(safeParseCatalog("nope").catalog).toBe(DEFAULT_CATALOG);
  });

  it("a coupon scope that does not resolve is rejected", () => {
    const bad = { ...baseCatalog, coupons: [{ code: "x", scope: { productCode: "ghost" }, kind: "flat", value: 10, totalUsageCap: 1, perPayerLimit: 1, ...WINDOW }] };
    expect(safeParseCatalog(bad).ok).toBe(false);
  });

  it("uses a supplied last-known-good fallback instead of DEFAULT", () => {
    const res = safeParseCatalog(undefined, baseCatalog);
    expect(res.ok).toBe(false);
    expect(res.catalog).toBe(baseCatalog);
  });
});

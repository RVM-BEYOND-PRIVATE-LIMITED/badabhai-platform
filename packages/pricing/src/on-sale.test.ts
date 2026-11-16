import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOG,
  MAX_CREDIT_VALIDITY_DAYS,
  creditPackTierSchema,
  isCreditPackOnSale,
  istDayStartMs,
  parseCatalog,
  safeParseCatalog,
} from "./index";

const TIER = { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14 };

describe("istDayStartMs — 00:00 IST on a YYYY-MM-DD date", () => {
  it("is 18:30 UTC the evening before", () => {
    expect(istDayStartMs("2027-04-01")).toBe(Date.parse("2027-03-31T18:30:00.000Z"));
    expect(istDayStartMs("2028-01-01")).toBe(Date.parse("2027-12-31T18:30:00.000Z"));
  });

  it("accepts 29 February only in a leap year", () => {
    expect(istDayStartMs("2028-02-29")).toBe(Date.parse("2028-02-28T18:30:00.000Z"));
    expect(istDayStartMs("2027-02-29")).toBeNull();
  });

  it.each(["2027-02-30", "2027-13-01", "2027-00-10", "2027-04-31", "2027-04-00", "0099-01-01"])(
    "is null for the impossible date %s",
    (date) => {
      expect(istDayStartMs(date)).toBeNull();
    },
  );

  it.each([
    "2027-4-1",
    "27-04-01",
    "2027/04/01",
    "2027-04-01T00:00",
    " 2027-04-01",
    "",
    "abcd-ef-gh",
  ])("is null for the malformed string %j", (date) => {
    expect(istDayStartMs(date)).toBeNull();
  });
});

describe("isCreditPackOnSale (#2749)", () => {
  const NOW = new Date("2026-11-16T06:00:00.000Z");

  it("a tier with neither field is on sale (every stored catalogue today)", () => {
    expect(isCreditPackOnSale(TIER, NOW)).toBe(true);
    expect(isCreditPackOnSale({ ...TIER, offered: true }, NOW)).toBe(true);
  });

  it("offered:false is never on sale, whatever the date", () => {
    expect(isCreditPackOnSale({ ...TIER, offered: false }, NOW)).toBe(false);
    expect(isCreditPackOnSale({ ...TIER, offered: false, onSaleFrom: "2020-01-01" }, NOW)).toBe(
      false,
    );
  });

  it("goes on sale at exactly 00:00 IST on onSaleFrom (the IST boundary)", () => {
    const annual = { ...TIER, onSaleFrom: "2027-04-01" };
    expect(isCreditPackOnSale(annual, new Date("2027-03-31T18:29:59.999Z"))).toBe(false);
    expect(isCreditPackOnSale(annual, new Date("2027-03-31T18:29:59Z"))).toBe(false);
    expect(isCreditPackOnSale(annual, new Date("2027-03-31T18:30:00Z"))).toBe(true);
    expect(isCreditPackOnSale(annual, new Date("2027-04-01T00:00:00Z"))).toBe(true);
    // A UTC reading of the date would wrongly hold it back for 5½ more hours.
    expect(isCreditPackOnSale(annual, new Date("2027-03-31T23:59:59Z"))).toBe(true);
  });

  it("a date already past is on sale; one in the future is not", () => {
    expect(isCreditPackOnSale({ ...TIER, onSaleFrom: "2026-11-16" }, NOW)).toBe(true);
    expect(isCreditPackOnSale({ ...TIER, onSaleFrom: "2026-11-17" }, NOW)).toBe(false);
  });

  it("FAILS CLOSED on an invalid clock or an unparseable date", () => {
    expect(isCreditPackOnSale(TIER, new Date(Number.NaN))).toBe(false);
    expect(isCreditPackOnSale({ ...TIER, onSaleFrom: "2027-02-30" }, NOW)).toBe(false);
  });
});

describe("creditPackTierSchema — the #2749 optional fields", () => {
  it("an old tier with none of them still validates (a stored row must not fall back)", () => {
    expect(creditPackTierSchema.parse(TIER)).toEqual(TIER);
    expect(safeParseCatalog(DEFAULT_CATALOG).ok).toBe(true);
  });

  it("accepts validityDays 1…3660 and null; refuses 0, a fraction and 3661", () => {
    expect(MAX_CREDIT_VALIDITY_DAYS).toBe(3660);
    for (const ok of [1, 30, 365, 3660, null]) {
      expect(creditPackTierSchema.safeParse({ ...TIER, validityDays: ok }).success).toBe(true);
    }
    for (const bad of [0, -30, 30.5, 3661, "30"]) {
      expect(creditPackTierSchema.safeParse({ ...TIER, validityDays: bad }).success).toBe(false);
    }
  });

  it("accepts a real YYYY-MM-DD onSaleFrom only", () => {
    expect(creditPackTierSchema.safeParse({ ...TIER, onSaleFrom: "2027-04-01" }).success).toBe(
      true,
    );
    for (const bad of ["2027-02-30", "2027-4-1", "2027-04-01T00:00:00Z", "", 20270401, null]) {
      expect(creditPackTierSchema.safeParse({ ...TIER, onSaleFrom: bad }).success).toBe(false);
    }
  });

  it("accepts a boolean offered only", () => {
    expect(creditPackTierSchema.safeParse({ ...TIER, offered: false }).success).toBe(true);
    expect(creditPackTierSchema.safeParse({ ...TIER, offered: "false" }).success).toBe(false);
  });

  it("strips an unknown tier key, as it always has", () => {
    expect(creditPackTierSchema.parse({ ...TIER, internalNote: "x" })).toEqual(TIER);
  });

  it("a whole catalogue carrying the new fields validates", () => {
    const cat = parseCatalog({
      ...DEFAULT_CATALOG,
      products: DEFAULT_CATALOG.products.map((p) =>
        p.kind === "credit_pack"
          ? {
              ...p,
              tiers: [
                { ...TIER, validityDays: 30 },
                { ...TIER, code: "pack_annual", validityDays: 365, onSaleFrom: "2027-04-01" },
                { ...TIER, code: "pack_retired", offered: false },
              ],
            }
          : p,
      ),
    });
    const packs = cat.products.find((p) => p.kind === "credit_pack")!;
    expect(packs.tiers.map((t) => t.code)).toEqual(["pack_starter", "pack_annual", "pack_retired"]);
  });

  it("DEFAULT_CATALOG's packs are unchanged and carry none of the new fields (#2749 go-live note)", () => {
    // Changing these packs is the go-live act (docs/runbooks/2749-publish-brief-credit-packs.md).
    // The e2e suites buy pack_50 / pack_200 to seed credits: update tests/e2e/helpers/credit-packs.ts
    // in the same change.
    const packs = DEFAULT_CATALOG.products.find((p) => p.kind === "credit_pack")!;
    expect(packs.tiers).toEqual([
      { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14 },
      { code: "pack_200", priceInr: 8000, credits: 200, windowDays: 14 },
      { code: "pack_1000", priceInr: 32000, credits: 1000, windowDays: 14 },
    ]);
  });
});

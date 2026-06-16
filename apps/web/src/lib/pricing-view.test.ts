import { describe, it, expect } from "vitest";
import type { CatalogView } from "./api";
import {
  toProductTierRows,
  extractCreditPacks,
  parseCatalogJson,
  parseChangedFields,
  formatCatalogJson,
  isUuid,
} from "./pricing-view";

/**
 * Tests for the PURE pricing-view logic (ADR-0013). Covers the catalog → summary
 * rows mapping, credit-pack extraction (the codes the top-up consumes), and the
 * honest client-side JSON guard.
 */

// A representative catalog mirroring the server DEFAULT (one product of each kind,
// plus an offer and a coupon) — minimal structural subset the console renders.
const CATALOG: CatalogView = {
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
    {
      kind: "boost",
      code: "job_boost",
      tiers: [{ code: "all_candidates", priceInr: 1200, boostDays: 2 }],
    },
    {
      kind: "credit_pack",
      code: "contact_unlock",
      tiers: [
        { code: "pack_10", priceInr: 1000, credits: 10, windowDays: 14 },
        { code: "pack_25", priceInr: 2000, credits: 25, windowDays: 14 },
      ],
    },
  ],
  offers: [
    {
      code: "launch",
      scope: { productCode: "job_posting" },
      kind: "percent",
      value: 20,
      from: "2026-06-01T00:00:00.000Z",
      until: "2026-07-01T00:00:00.000Z",
    },
  ],
  coupons: [
    {
      code: "welcome",
      scope: { productCode: "contact_unlock", tierCode: "pack_10" },
      kind: "flat",
      value: 100,
      from: "2026-06-01T00:00:00.000Z",
      until: "2026-07-01T00:00:00.000Z",
      totalUsageCap: 100,
      perPayerLimit: 1,
    },
  ],
};

describe("toProductTierRows", () => {
  it("flattens every product/tier into one row each", () => {
    const rows = toProductTierRows(CATALOG);
    // 2 posting + 1 boost + 2 credit_pack = 5 rows.
    expect(rows).toHaveLength(5);
  });

  it("maps posting tiers with validity + applicant quota, and nulls the rest", () => {
    const rows = toProductTierRows(CATALOG);
    const std = rows.find((r) => r.tierCode === "standard");
    expect(std).toMatchObject({
      productCode: "job_posting",
      kind: "posting",
      kindLabel: "Job posting plan",
      priceInr: 1000,
      validityDays: 14,
      applicantVisibilityQuota: 10,
      boostDays: null,
      credits: null,
    });
  });

  it("maps boost tiers with boostDays only", () => {
    const boost = toProductTierRows(CATALOG).find((r) => r.kind === "boost");
    expect(boost).toMatchObject({
      tierCode: "all_candidates",
      boostDays: 2,
      validityDays: null,
      applicantVisibilityQuota: null,
      credits: null,
    });
  });

  it("maps credit_pack tiers with credits + window (validityDays = windowDays)", () => {
    const pack = toProductTierRows(CATALOG).find((r) => r.tierCode === "pack_10");
    expect(pack).toMatchObject({
      kind: "credit_pack",
      kindLabel: "Credit pack",
      priceInr: 1000,
      credits: 10,
      validityDays: 14,
      boostDays: null,
      applicantVisibilityQuota: null,
    });
  });

  it("returns an empty array for a catalog with no products", () => {
    expect(toProductTierRows({ products: [], offers: [], coupons: [] })).toEqual([]);
  });
});

describe("extractCreditPacks", () => {
  it("pulls the credit_pack tier codes the top-up consumes, in order", () => {
    const packs = extractCreditPacks(CATALOG);
    expect(packs.map((p) => p.code)).toEqual(["pack_10", "pack_25"]);
    expect(packs[0]).toEqual({
      code: "pack_10",
      priceInr: 1000,
      credits: 10,
      windowDays: 14,
    });
  });

  it("ignores posting/boost products entirely", () => {
    const packs = extractCreditPacks(CATALOG);
    expect(packs.every((p) => p.code.startsWith("pack_"))).toBe(true);
  });

  it("returns an empty list when there are no credit packs", () => {
    const noPacks: CatalogView = {
      products: [
        { kind: "boost", code: "job_boost", tiers: [{ code: "x", priceInr: 1, boostDays: 1 }] },
      ],
      offers: [],
      coupons: [],
    };
    expect(extractCreditPacks(noPacks)).toEqual([]);
  });
});

describe("parseCatalogJson — honest client-side guard", () => {
  it("accepts a valid JSON object and returns the parsed value", () => {
    const res = parseCatalogJson('{"products":[]}');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ products: [] });
  });

  it("rejects empty input", () => {
    const res = parseCatalogJson("   ");
    expect(res).toEqual({ ok: false, error: "Catalog JSON is empty." });
  });

  it("rejects malformed JSON with an honest parse error", () => {
    const res = parseCatalogJson("{ not json ]");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Invalid JSON");
  });

  it("rejects a JSON array (catalog must be an object)", () => {
    const res = parseCatalogJson("[1,2,3]");
    expect(res).toEqual({ ok: false, error: "Catalog must be a JSON object." });
  });

  it("rejects a JSON null / primitive", () => {
    expect(parseCatalogJson("null").ok).toBe(false);
    expect(parseCatalogJson("42").ok).toBe(false);
  });

  it("does NOT validate catalog shape (server's catalogSchema owns that)", () => {
    // A structurally-bogus catalog still parses as JSON — the guard only checks
    // that it is parseable JSON object; the server returns the verbatim 400.
    const res = parseCatalogJson('{"garbage": true}');
    expect(res.ok).toBe(true);
  });
});

describe("parseChangedFields", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseChangedFields(" priceInr, validityDays ,, ")).toEqual([
      "priceInr",
      "validityDays",
    ]);
  });
  it("returns an empty array for blank input", () => {
    expect(parseChangedFields("   ")).toEqual([]);
  });
});

describe("formatCatalogJson", () => {
  it("pretty-prints with 2-space indent and round-trips through parse", () => {
    const text = formatCatalogJson(CATALOG);
    expect(text).toContain('\n  "products"');
    const res = parseCatalogJson(text);
    expect(res.ok).toBe(true);
  });
});

describe("isUuid", () => {
  it("accepts a v4-shaped uuid", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
  });
  it("rejects garbage / empty", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG, type Product } from "@badabhai/pricing";
import { applicantQuotaStep, baseApplicantQuotaForBand, quotaTopUpTier } from "./pricing-config";

/**
 * Pricing-config tests — every figure must come from the catalog PRODUCTS the caller
 * passes in (since D-6 that is the LIVE catalog, with DEFAULT_CATALOG only as the
 * fetch-failure fallback), never a literal. quotaTopUpTier() feeds the LIVE
 * quota-topup body (the tier CODE, XT5) and the top-up success copy (addedViews) —
 * pin its selection rule against the default products AND against a LIVE (edited)
 * products array, proving there is no hidden compile-time read left.
 */
describe("quotaTopUpTier — the catalog quota_topup tier one top-up purchases", () => {
  it("returns the SMALLEST catalog tier (code + price + views), straight from config", () => {
    const tier = quotaTopUpTier(DEFAULT_CATALOG.products);
    expect(tier).not.toBeNull();
    // The default catalog's smallest quota_topup tier (topup_10 < topup_30 by views).
    expect(tier!.code).toBe("topup_10");
    expect(tier!.additionalViews).toBe(10);
    expect(tier!.priceInr).toBeGreaterThan(0);
  });

  it("agrees with the posting-tier quota step (the same 'one step' the UI copy shows)", () => {
    // Both derive from config; the smallest top-up grant matches the smallest quota step.
    expect(quotaTopUpTier(DEFAULT_CATALOG.products)!.additionalViews).toBe(
      applicantQuotaStep(DEFAULT_CATALOG.products),
    );
  });

  it("D-6: reads the PASSED products (a live ops edit changes the result — no hidden DEFAULT_CATALOG)", () => {
    // A "live" catalog where ops renamed + re-priced the smallest top-up tier.
    const liveProducts: Product[] = [
      {
        kind: "quota_topup",
        code: "quota_topup",
        tiers: [{ code: "topup_5_live", priceInr: 149, additionalVisibilityQuota: 5 }],
      },
    ];
    const tier = quotaTopUpTier(liveProducts);
    expect(tier).toEqual({ code: "topup_5_live", priceInr: 149, additionalViews: 5 });
    // And the fallback products still resolve the default — the two are independent inputs.
    expect(quotaTopUpTier(DEFAULT_CATALOG.products)!.code).toBe("topup_10");
  });
});

describe("baseApplicantQuotaForBand — scales the (server-resolved) config step, client-safe", () => {
  it("scales the passed step by the band index (smallest band → 1×)", () => {
    expect(baseApplicantQuotaForBand("1-5", 10)).toBe(10);
    expect(baseApplicantQuotaForBand("6-20", 10)).toBe(20);
    expect(baseApplicantQuotaForBand("50+", 10)).toBe(40);
  });

  it("fails closed to null when no step was resolvable (no catalog posting tiers)", () => {
    expect(baseApplicantQuotaForBand("1-5", null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { applicantQuotaStep, quotaTopUpTier } from "./pricing-config";

/**
 * Pricing-config tests — every figure must come from @badabhai/pricing DEFAULT_CATALOG
 * (ADR-0013), never a literal. quotaTopUpTier() feeds the LIVE quota-topup body (the
 * tier CODE, XT5) and the top-up success copy (addedViews) — pin its selection rule.
 */
describe("quotaTopUpTier — the catalog quota_topup tier one top-up purchases", () => {
  it("returns the SMALLEST catalog tier (code + price + views), straight from config", () => {
    const tier = quotaTopUpTier();
    expect(tier).not.toBeNull();
    // The default catalog's smallest quota_topup tier (topup_10 < topup_30 by views).
    expect(tier!.code).toBe("topup_10");
    expect(tier!.additionalViews).toBe(10);
    expect(tier!.priceInr).toBeGreaterThan(0);
  });

  it("agrees with the posting-tier quota step (the same 'one step' the UI copy shows)", () => {
    // Both derive from config; the smallest top-up grant matches the smallest quota step.
    expect(quotaTopUpTier()!.additionalViews).toBe(applicantQuotaStep());
  });
});

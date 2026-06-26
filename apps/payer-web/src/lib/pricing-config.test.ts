import { afterEach, describe, expect, it } from "vitest";
import {
  bandForVacancies,
  creditValidityMonths,
  findCreditPack,
  lowBalanceThreshold,
  offeredCreditPacks,
  postingPaidTiers,
  unlockUnitPriceInr,
} from "./pricing-config";

describe("pricing-config (config-sourced, no hardcoded prices)", () => {
  it("offers EXACTLY the §3A credit packs from the catalog (CEO-final 2026-06-22)", () => {
    const packs = offeredCreditPacks();
    // The OFFERED packs are exactly the three §3A tiers — code/price/credits pinned.
    // pack_1000 is ₹32,000 after the CEO 20% volume discount (verified vs DEFAULT_CATALOG).
    expect(packs).toEqual([
      { code: "pack_50", priceInr: 2000, credits: 50 },
      { code: "pack_200", priceInr: 8000, credits: 200 },
      { code: "pack_1000", priceInr: 32000, credits: 1000 },
    ]);
  });

  it("EXCLUDES the legacy pack_10 / pack_25 from the offered set", () => {
    const codes = offeredCreditPacks().map((p) => p.code);
    expect(codes).not.toContain("pack_10");
    expect(codes).not.toContain("pack_25");
  });

  it("derives the per-unlock unit price as ₹40 from the smallest pack", () => {
    expect(unlockUnitPriceInr()).toBe(40);
  });

  it("resolves a known pack by code and rejects an unknown one", () => {
    expect(findCreditPack("pack_50")?.code).toBe("pack_50");
    expect(findCreditPack("does_not_exist")).toBeNull();
    // The legacy codes are NOT resolvable through the offered set either.
    expect(findCreditPack("pack_10")).toBeNull();
    expect(findCreditPack("pack_25")).toBeNull();
  });

  it("exposes the post-launch paid posting tiers from the catalog (never ₹0)", () => {
    const tiers = postingPaidTiers();
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) {
      // The catalog cannot model ₹0 — every tier is a positive integer.
      expect(t.priceInr).toBeGreaterThan(0);
    }
  });
});

describe("bandForVacancies — derive the FRONTEND quota band from a raw head count", () => {
  it("maps counts to the frontend band-set at the boundaries", () => {
    expect(bandForVacancies(1)).toBe("1-5");
    expect(bandForVacancies(5)).toBe("1-5");
    expect(bandForVacancies(6)).toBe("6-20");
    expect(bandForVacancies(20)).toBe("6-20");
    expect(bandForVacancies(21)).toBe("21-50");
    expect(bandForVacancies(50)).toBe("21-50");
    expect(bandForVacancies(51)).toBe("50+");
    expect(bandForVacancies(10_000)).toBe("50+");
  });

  it("fails closed to the smallest band on a non-positive / non-integer count", () => {
    expect(bandForVacancies(0)).toBe("1-5");
    expect(bandForVacancies(-7)).toBe("1-5");
    expect(bandForVacancies(2.5)).toBe("1-5");
    expect(bandForVacancies(Number.NaN)).toBe("1-5");
  });
});

describe("lowBalanceThreshold — read from config (env), never a page literal", () => {
  afterEach(() => {
    delete process.env.PAYER_LOW_BALANCE_THRESHOLD;
  });

  it("returns the config default when the env var is unset", () => {
    delete process.env.PAYER_LOW_BALANCE_THRESHOLD;
    const t = lowBalanceThreshold();
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(0);
  });

  it("honours a valid env override", () => {
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "12";
    expect(lowBalanceThreshold()).toBe(12);
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "0";
    expect(lowBalanceThreshold()).toBe(0);
  });

  it("ignores an invalid env value and falls back to the default", () => {
    const def = lowBalanceThreshold();
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "-3";
    expect(lowBalanceThreshold()).toBe(def);
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "abc";
    expect(lowBalanceThreshold()).toBe(def);
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "2.5";
    expect(lowBalanceThreshold()).toBe(def);
  });
});

describe("creditValidityMonths — credit-expiry window from config (default 12), not a literal", () => {
  afterEach(() => {
    delete process.env.PAYER_CREDIT_VALIDITY_MONTHS;
  });

  it("defaults to 12 months when unset (honours the requested 12-month expiry)", () => {
    delete process.env.PAYER_CREDIT_VALIDITY_MONTHS;
    expect(creditValidityMonths()).toBe(12);
  });

  it("honours a valid positive-integer env override", () => {
    process.env.PAYER_CREDIT_VALIDITY_MONTHS = "6";
    expect(creditValidityMonths()).toBe(6);
  });

  it("ignores a non-positive / non-integer env value and falls back to 12", () => {
    process.env.PAYER_CREDIT_VALIDITY_MONTHS = "0";
    expect(creditValidityMonths()).toBe(12);
    process.env.PAYER_CREDIT_VALIDITY_MONTHS = "-1";
    expect(creditValidityMonths()).toBe(12);
    process.env.PAYER_CREDIT_VALIDITY_MONTHS = "1.5";
    expect(creditValidityMonths()).toBe(12);
  });
});

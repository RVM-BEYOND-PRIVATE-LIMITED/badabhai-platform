import { describe, expect, it } from "vitest";
import {
  findCreditPack,
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

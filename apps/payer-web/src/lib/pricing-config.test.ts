import { describe, expect, it } from "vitest";
import { findCreditPack, offeredCreditPacks, postingPaidTiers } from "./pricing-config";

describe("pricing-config (config-sourced, no hardcoded prices)", () => {
  it("offers the §3A credit packs from the catalog", () => {
    const packs = offeredCreditPacks();
    expect(packs.length).toBeGreaterThan(0);
    const codes = packs.map((p) => p.code);
    expect(codes).toContain("pack_50");
    // Prices are integers > 0 (catalog priceInr min(1)).
    for (const p of packs) {
      expect(Number.isInteger(p.priceInr)).toBe(true);
      expect(p.priceInr).toBeGreaterThan(0);
      expect(p.credits).toBeGreaterThan(0);
    }
  });

  it("resolves a known pack by code and rejects an unknown one", () => {
    expect(findCreditPack("pack_50")?.code).toBe("pack_50");
    expect(findCreditPack("does_not_exist")).toBeNull();
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

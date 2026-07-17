import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Capacity-upgrade Server-Action tests (A1, ADR-0016 — MOCK payment only). Covers:
 *  - GATE-FIRST authz: requirePayer() runs FIRST (an unauthenticated caller's redirect
 *    short-circuits before the tier check or the seam is touched);
 *  - VALUE GUARD (no-oracle): a tier NOT in hiringCapacityTiers() is rejected with a NEUTRAL
 *    error and NEVER forwarded to the seam (it is a value guard, not authz);
 *  - SUCCESS: a known tier maps the seam's resumedPlanIds → resumedCount = length;
 *  - NEUTRAL FAILURE: the seam's `{ ok:false }` surfaces as a neutral error, never a fake
 *    success, and carries no role name / deny cause / PII (faceless + no-oracle).
 *
 * The seam-level XB-A (no payer_id) / XT5 (no price) body assertions live in
 * `lib/payer-api.test.ts` (buyCapacity); here the tier CODE is the only thing the action
 * forwards, so the action can never smuggle a price/payer_id either.
 */

const requirePayer = vi.fn();
const buyCapacity = vi.fn();
const hiringCapacityTiers = vi.fn();
const revalidatePath = vi.fn();
// The LIVE catalog seam (D-6): the value guard now checks the tier against the LIVE tiers.
// The seam itself fails OPEN to the defaults (live-catalog.test.ts) — here it just feeds
// the (mocked) pricing-config reader, so the guard's behaviour stays the thing under test.
const getLiveCatalog = vi.fn();

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/payer-api", () => ({ buyCapacity: (i: { tier: string }) => buyCapacity(i) }));
vi.mock("../../../lib/pricing-config", () => ({ hiringCapacityTiers: () => hiringCapacityTiers() }));
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { upgradeCapacityAction } = await import("./actions");

const TIERS = [
  { code: "starter", priceInr: 999, maxActiveVacancies: 5 },
  { code: "growth", priceInr: 4999, maxActiveVacancies: 10 },
];

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue({ payerId: "p", role: "employer", displayLabel: "Acme" });
  buyCapacity.mockReset();
  hiringCapacityTiers.mockReset().mockReturnValue(TIERS);
  getLiveCatalog.mockReset().mockResolvedValue({ products: [], live: true });
  revalidatePath.mockReset();
});

describe("upgradeCapacityAction — gate FIRST (requirePayer before any work)", () => {
  it("runs requirePayer FIRST; an unauthenticated caller never reaches the tier check or seam", async () => {
    requirePayer.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(upgradeCapacityAction({ tier: "growth" })).rejects.toThrow("NEXT_REDIRECT");
    expect(getLiveCatalog).not.toHaveBeenCalled();
    expect(hiringCapacityTiers).not.toHaveBeenCalled();
    expect(buyCapacity).not.toHaveBeenCalled();
  });
});

describe("upgradeCapacityAction — value guard (unknown tier rejected neutrally, no seam call)", () => {
  it("rejects a tier NOT in the config'd tiers with a NEUTRAL error and never calls the seam", async () => {
    const res = await upgradeCapacityAction({ tier: "rocket_tier" });
    expect(res).toEqual({ ok: false, error: "Choose a capacity tier to upgrade." });
    expect(buyCapacity).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an empty tier the same neutral way (cannot smuggle a blank/arbitrary string)", async () => {
    const res = await upgradeCapacityAction({ tier: "" });
    expect(res.ok).toBe(false);
    expect(buyCapacity).not.toHaveBeenCalled();
  });
});

describe("upgradeCapacityAction — success maps resumedPlanIds → resumedCount", () => {
  it("on a known tier, returns resumedCount = resumedPlanIds.length and the new allowance", async () => {
    buyCapacity.mockResolvedValueOnce({
      ok: true,
      allowance: 10,
      sourceTier: "growth",
      expiresAt: null,
      resumedPlanIds: ["a", "b", "c"],
    });
    const res = await upgradeCapacityAction({ tier: "growth" });
    expect(res).toEqual({ ok: true, resumedCount: 3, allowance: 10 });
    expect(buyCapacity).toHaveBeenCalledWith({ tier: "growth" }); // tier CODE only.
    expect(revalidatePath).toHaveBeenCalledWith("/capacity");
  });

  it("an empty resumedPlanIds list → resumedCount 0 (nothing was paused to resume)", async () => {
    buyCapacity.mockResolvedValueOnce({
      ok: true,
      allowance: 5,
      sourceTier: "starter",
      expiresAt: null,
      resumedPlanIds: [],
    });
    const res = await upgradeCapacityAction({ tier: "starter" });
    expect(res).toEqual({ ok: true, resumedCount: 0, allowance: 5 });
  });
});

describe("upgradeCapacityAction — neutral failure (no fake success, no leaked reason / PII)", () => {
  it("maps the seam's { ok:false } to a neutral error and does NOT revalidate", async () => {
    buyCapacity.mockResolvedValueOnce({ ok: false, error: "Capacity upgrade failed. Please retry." });
    const res = await upgradeCapacityAction({ tier: "growth" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // No-oracle / faceless: no role name, deny cause, or PII-looking key in the error.
      expect(res.error).not.toMatch(/payer_id|forbidden|employer|agent|consent|phone|email/i);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

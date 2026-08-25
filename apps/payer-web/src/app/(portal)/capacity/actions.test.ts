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
const getCapacity = vi.fn();
const hiringCapacityTiers = vi.fn();
const revalidatePath = vi.fn();
// The LIVE catalog seam (D-6): the value guard now checks the tier against the LIVE tiers.
// The seam itself fails OPEN to the defaults (live-catalog.test.ts) — here it just feeds
// the (mocked) pricing-config reader, so the guard's behaviour stays the thing under test.
const getLiveCatalog = vi.fn();

/**
 * The REAL typed 409 the seam throws (#1165). `instanceof` must hold across the mock boundary,
 * so the class defined here is the one exported from the mocked module.
 */
class PurchaseConflictError extends Error {
  constructor() {
    super("duplicate purchase in flight");
    this.name = "PurchaseConflictError";
  }
}

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/payer-api", () => ({
  buyCapacity: (i: { tier: string; idempotencyKey?: string }) => buyCapacity(i),
  getCapacity: () => getCapacity(),
  PurchaseConflictError,
}));
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
  getCapacity.mockReset().mockResolvedValue({ activeVacancyAllowance: 10 });
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
    if (!res.ok && "error" in res) {
      // No-oracle / faceless: no role name, deny cause, or PII-looking key in the error.
      expect(res.error).not.toMatch(/payer_id|forbidden|employer|agent|consent|phone|email/i);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * IDEMPOTENCY + 409 = PENDING, not done (#1185, correcting #1165/#1148). The action threads the
 * client-minted per-purchase key to the seam. The backend 409s ONLY while the FIRST attempt is
 * still in flight (uncommitted, may still throw) — so a 409 is "still processing, outcome UNKNOWN",
 * NOT a completed purchase. The action RE-READS the CURRENT allowance for display but returns a
 * NON-terminal `pending` result (never `ok:true`), and must never re-POST (that would double-fire
 * the payment/coupon spine).
 */
describe("upgradeCapacityAction — Idempotency-Key threading + 409 = pending (#1185)", () => {
  const KEY = "5f9d1c2e-1a2b-4c3d-8e4f-0a1b2c3d4e5f"; // a client crypto.randomUUID()

  it("forwards a well-formed idempotency key to the seam (alongside the tier CODE)", async () => {
    buyCapacity.mockResolvedValueOnce({
      ok: true,
      allowance: 10,
      sourceTier: "growth",
      expiresAt: null,
      resumedPlanIds: [],
    });
    await upgradeCapacityAction({ tier: "growth", idempotencyKey: KEY });
    expect(buyCapacity).toHaveBeenCalledWith({ tier: "growth", idempotencyKey: KEY });
  });

  it("DROPS a malformed key (degrades to no-key) rather than forwarding junk", async () => {
    buyCapacity.mockResolvedValueOnce({
      ok: true,
      allowance: 10,
      sourceTier: "growth",
      expiresAt: null,
      resumedPlanIds: [],
    });
    await upgradeCapacityAction({ tier: "growth", idempotencyKey: "not-a-uuid" });
    expect(buyCapacity).toHaveBeenCalledWith({ tier: "growth", idempotencyKey: undefined });
  });

  it("a 409 is NON-terminal PENDING — never ok:true, re-reads the CURRENT allowance, no second POST", async () => {
    buyCapacity.mockRejectedValueOnce(new PurchaseConflictError());
    getCapacity.mockResolvedValueOnce({ activeVacancyAllowance: 10 }); // the CURRENT (not-final) allowance
    const res = await upgradeCapacityAction({ tier: "growth", idempotencyKey: KEY });

    // A 409 = "still running, outcome unknown": NOT a completed purchase — never a terminal success.
    expect(res).toEqual({ ok: false, pending: true, allowance: 10 });
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty("duplicate"); // the old false-terminal-success shape is gone
    expect(res).not.toHaveProperty("resumedCount"); // never a guessed number

    // Exactly ONE capacity POST (buyCapacity), then a GET re-read — never a re-POST.
    expect(buyCapacity).toHaveBeenCalledTimes(1);
    expect(getCapacity).toHaveBeenCalledTimes(1);
    // The view is revalidated so the page reflects the CURRENT allowance (still current-not-final).
    expect(revalidatePath).toHaveBeenCalledWith("/capacity");
  });

  it("a 409 whose re-read ALSO blips stays PENDING with no figure — never ok:true, never a fabricated allowance", async () => {
    buyCapacity.mockRejectedValueOnce(new PurchaseConflictError());
    getCapacity.mockRejectedValueOnce(new Error("boom"));
    const res = await upgradeCapacityAction({ tier: "growth", idempotencyKey: KEY });
    expect(res).toEqual({ ok: false, pending: true });
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty("allowance"); // no invented number
    expect(buyCapacity).toHaveBeenCalledTimes(1); // no re-POST
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * POSTING-DETAIL buy Server-Action tests (B3 / #179 — MOCK payment only). Covers:
 *  - GATE-FIRST authz: requirePayer() runs FIRST (an unauthenticated caller's redirect
 *    short-circuits before the tier check or the seam is touched);
 *  - VALUE GUARD (no-oracle): a tier NOT in the config'd tiers OR a bad posting id is rejected
 *    with a NEUTRAL error and NEVER forwarded to the seam;
 *  - SUCCESS: a known plan/boost tier maps the seam result + revalidates the posting path;
 *  - NEUTRAL FAILURE: the seam's `{ ok:false }` surfaces as a neutral error, never a fake
 *    success, and carries no role name / deny cause / PII (faceless + no-oracle).
 *
 * The seam-level XB-A (no payer_id) / XT5 (no price) body assertions live in
 * `lib/payer-api.test.ts` (buyPlan/buyBoost); here the tier CODE + coupon are the only things the
 * action forwards, so the action can never smuggle a price/payer_id/id-in-body either.
 */

const requirePayer = vi.fn();
const buyPlan = vi.fn();
const buyBoost = vi.fn();
const postingPlanTiers = vi.fn();
const boostTiers = vi.fn();
const revalidatePath = vi.fn();

vi.mock("../../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../../lib/payer-api", () => ({
  buyPlan: (i: unknown) => buyPlan(i),
  buyBoost: (i: unknown) => buyBoost(i),
}));
vi.mock("../../../../lib/pricing-config", () => ({
  postingPlanTiers: () => postingPlanTiers(),
  boostTiers: () => boostTiers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { buyPlanAction, buyBoostAction } = await import("./actions");

const POSTING_ID = "bbbb2222-0000-4000-8000-000000000001";
const PLAN_TIERS = [
  { code: "standard", priceInr: 1000, validityDays: 14, applicantVisibilityQuota: 10 },
  { code: "pro", priceInr: 2500, validityDays: 30, applicantVisibilityQuota: 30 },
];
const BOOST_TIERS = [{ code: "all_candidates", priceInr: 1200, boostDays: 2 }];

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue({ payerId: "p", role: "employer", displayLabel: "Acme" });
  buyPlan.mockReset().mockResolvedValue({ ok: true, tier: "standard", status: "active", paused: false, expiresAt: null });
  buyBoost.mockReset().mockResolvedValue({ ok: true, tier: "all_candidates", status: "active", endsAt: null });
  postingPlanTiers.mockReset().mockReturnValue(PLAN_TIERS);
  boostTiers.mockReset().mockReturnValue(BOOST_TIERS);
  revalidatePath.mockReset();
});

describe("buyPlanAction — gate FIRST (requirePayer before any work)", () => {
  it("runs requirePayer FIRST; an unauthenticated caller never reaches the tier check or seam", async () => {
    requirePayer.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(buyPlanAction({ postingId: POSTING_ID, tier: "standard" })).rejects.toThrow("NEXT_REDIRECT");
    expect(buyPlan).not.toHaveBeenCalled();
  });
});

describe("buyPlanAction — value guard (unknown tier / bad id rejected neutrally, no seam call)", () => {
  it("rejects a tier NOT in the config'd plan tiers with a NEUTRAL error and never calls the seam", async () => {
    const res = await buyPlanAction({ postingId: POSTING_ID, tier: "rocket_tier" });
    expect(res).toEqual({ ok: false, error: "Choose a plan to buy." });
    expect(buyPlan).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID posting id neutrally (cannot smuggle an arbitrary id)", async () => {
    const res = await buyPlanAction({ postingId: "not-a-uuid", tier: "standard" });
    expect(res).toEqual({ ok: false, error: "That posting could not be found." });
    expect(buyPlan).not.toHaveBeenCalled();
  });
});

describe("buyPlanAction — success forwards { postingId, tier, coupon } + revalidates the posting", () => {
  it("on a known tier, maps the seam result and revalidates the posting path (tier CODE only)", async () => {
    buyPlan.mockResolvedValueOnce({ ok: true, tier: "pro", status: "active", paused: false, expiresAt: "2026-07-20T00:00:00.000Z" });
    const res = await buyPlanAction({ postingId: POSTING_ID, tier: "pro", coupon: "SAVE10" });
    expect(res).toEqual({ ok: true, tier: "pro", status: "active", paused: false, expiresAt: "2026-07-20T00:00:00.000Z" });
    expect(buyPlan).toHaveBeenCalledWith({ postingId: POSTING_ID, tier: "pro", coupon: "SAVE10" });
    expect(revalidatePath).toHaveBeenCalledWith(`/postings/${POSTING_ID}`);
  });

  it("surfaces paused=true (over-capacity) faithfully from the seam", async () => {
    buyPlan.mockResolvedValueOnce({ ok: true, tier: "standard", status: "paused", paused: true, expiresAt: null });
    const res = await buyPlanAction({ postingId: POSTING_ID, tier: "standard" });
    expect(res).toMatchObject({ ok: true, paused: true, status: "paused" });
  });
});

describe("buyPlanAction — neutral failure (no fake success, no leaked reason / PII)", () => {
  it("maps the seam's { ok:false } to a neutral error and does NOT revalidate", async () => {
    buyPlan.mockResolvedValueOnce({ ok: false, error: "Plan purchase failed (service unavailable). Please retry." });
    const res = await buyPlanAction({ postingId: POSTING_ID, tier: "standard" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toMatch(/payer_id|forbidden|employer|agent|consent|phone|email/i);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("buyBoostAction — gate + value guard + success + neutral failure", () => {
  it("runs requirePayer FIRST", async () => {
    requirePayer.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(buyBoostAction({ postingId: POSTING_ID, tier: "all_candidates" })).rejects.toThrow("NEXT_REDIRECT");
    expect(buyBoost).not.toHaveBeenCalled();
  });

  it("rejects an unknown boost tier neutrally and never calls the seam", async () => {
    const res = await buyBoostAction({ postingId: POSTING_ID, tier: "mega_boost" });
    expect(res).toEqual({ ok: false, error: "Choose a boost to buy." });
    expect(buyBoost).not.toHaveBeenCalled();
  });

  it("on all_candidates, forwards the tier code + revalidates the posting path", async () => {
    const res = await buyBoostAction({ postingId: POSTING_ID, tier: "all_candidates" });
    expect(res).toEqual({ ok: true, tier: "all_candidates", status: "active", endsAt: null });
    expect(buyBoost).toHaveBeenCalledWith({ postingId: POSTING_ID, tier: "all_candidates", coupon: undefined });
    expect(revalidatePath).toHaveBeenCalledWith(`/postings/${POSTING_ID}`);
  });

  it("maps the seam's { ok:false } to a neutral error, no revalidate, no leaked cause", async () => {
    buyBoost.mockResolvedValueOnce({ ok: false, error: "Boost purchase failed (service unavailable). Please retry." });
    const res = await buyBoostAction({ postingId: POSTING_ID, tier: "all_candidates" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toMatch(/payer_id|forbidden|409|already/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

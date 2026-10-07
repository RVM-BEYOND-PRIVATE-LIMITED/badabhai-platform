import { beforeEach, describe, expect, it, vi } from "vitest";
import { PriceMismatchError, PurchaseOptionChangedError } from "../../../lib/payer-errors";
import { PRICE_UNREADABLE_MESSAGE } from "../../../lib/price-confirmation";
import type { PostingSummary } from "../../../lib/contracts";

/**
 * Lifecycle Server Action tests (LIVE pause/resume/quota-topup/close). The seam is
 * mocked — these pin the ACTION layer's contracts:
 *  - uuid gate → the SAME neutral not-found copy (no oracle via validation);
 *  - null from the seam (neutral 404) → the SAME neutral not-found copy;
 *  - QuotaTopUpNoPlanError → the ONE actionable business-deny copy ("buy a plan first");
 *  - a committed top-up NEVER surfaces as a retryable error (double-purchase guard) —
 *    a null fresh-row still returns ok:true with the "refresh" notice;
 *  - every success revalidates /postings.
 */

const pausePosting = vi.fn();
const resumePosting = vi.fn();
const topUpPostingQuota = vi.fn();
const closePosting = vi.fn();
const revalidatePath = vi.fn();

class QuotaTopUpNoPlanError extends Error {}
/** The seam's typed in-flight 409 (#2085) — exported from the mock so `instanceof` holds. */
class PurchaseConflictError extends Error {}

vi.mock("../../../lib/payer-api", () => ({
  pausePosting: (i: unknown) => pausePosting(i),
  resumePosting: (i: unknown) => resumePosting(i),
  topUpPostingQuota: (i: unknown) => topUpPostingQuota(i),
  closePosting: (i: unknown) => closePosting(i),
  QuotaTopUpNoPlanError,
  PurchaseConflictError,
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { pausePostingAction, resumePostingAction, topUpQuotaAction, closePostingAction } =
  await import("./actions");

const ID = "bbbb2222-0000-4000-8000-000000000001";
/** The tier the payer confirmed in the dialog (#2085 L1): its code and the slots it adds. */
const TIER = { code: "topup_10", additionalViews: 10 };
const POSTING: PostingSummary = {
  id: ID,
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  vacancyBand: "6-10",
  status: "open",
  applicantCount: 0,
  createdAt: "2026-06-22T00:00:00.000Z",
};

beforeEach(() => {
  pausePosting.mockReset();
  resumePosting.mockReset();
  topUpPostingQuota.mockReset();
  closePosting.mockReset();
  revalidatePath.mockReset();
});

describe("pause/resume/close actions — neutral gates + revalidate", () => {
  it("an invalid uuid returns the SAME neutral not-found without touching the seam", async () => {
    const res = await pausePostingAction({ postingId: "not-a-uuid" });
    expect(res).toEqual({ ok: false, error: "That posting could not be found." });
    expect(pausePosting).not.toHaveBeenCalled();
  });

  it("a null seam result (neutral 404) maps to the SAME neutral not-found", async () => {
    resumePosting.mockResolvedValue(null);
    const res = await resumePostingAction({ postingId: ID });
    expect(res).toEqual({ ok: false, error: "That posting could not be found." });
  });

  it("success returns the fresh posting and revalidates /postings (pause + close)", async () => {
    pausePosting.mockResolvedValue({ ...POSTING, status: "paused" });
    const paused = await pausePostingAction({ postingId: ID });
    expect(paused.ok).toBe(true);
    if (paused.ok) expect(paused.posting.status).toBe("paused");

    closePosting.mockResolvedValue({ ...POSTING, status: "closed" });
    const closed = await closePostingAction({ postingId: ID });
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.posting.status).toBe("closed");

    expect(revalidatePath).toHaveBeenCalledWith("/postings");
    expect(revalidatePath).toHaveBeenCalledTimes(2);
  });

  it("a thrown seam error (transport / 409 not-open) maps to ONE retryable message", async () => {
    pausePosting.mockRejectedValue(new Error("payer API x returned 409"));
    const res = await pausePostingAction({ postingId: ID });
    expect(res).toEqual({
      ok: false,
      error: "Could not pause the posting right now. Please retry.",
    });
  });
});

describe("topUpQuotaAction — the paid action's honesty contracts", () => {
  it("success with a fresh row → ok + the 'added N views' notice", async () => {
    topUpPostingQuota.mockResolvedValue({ posting: POSTING, addedViews: 10 });
    const res = await topUpQuotaAction({ postingId: ID, tier: TIER });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.posting).toEqual(POSTING);
      expect(res.notice).toBe("Applicant slots added — 10 more applicant views.");
    }
    expect(revalidatePath).toHaveBeenCalledWith("/postings");
  });

  it("a committed charge with a failed re-read is STILL ok (never 'please retry')", async () => {
    topUpPostingQuota.mockResolvedValue({ posting: null, addedViews: 10 });
    const res = await topUpQuotaAction({ postingId: ID, tier: TIER });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.posting).toBeNull();
      expect(res.notice).toContain("refresh to see it");
      expect(res.notice).not.toMatch(/retry/i);
    }
  });

  it("QuotaTopUpNoPlanError → the actionable 'buy a plan first' copy", async () => {
    topUpPostingQuota.mockRejectedValue(new QuotaTopUpNoPlanError("no active plan"));
    const res = await topUpQuotaAction({ postingId: ID, tier: TIER });
    expect(res).toEqual({
      ok: false,
      error: "This posting has no active plan yet — buy a plan first.",
    });
  });

  it("a null outcome (neutral 404 — the POST itself) maps to not-found, and a transport throw to retry copy", async () => {
    topUpPostingQuota.mockResolvedValue(null);
    expect(await topUpQuotaAction({ postingId: ID, tier: TIER })).toEqual({
      ok: false,
      error: "That posting could not be found.",
    });
    topUpPostingQuota.mockRejectedValue(new Error("network"));
    expect(await topUpQuotaAction({ postingId: ID, tier: TIER })).toEqual({
      ok: false,
      error: "Could not add applicant slots right now. Please retry.",
    });
  });
});

/**
 * #2085 — the top-up is a confirmed, idempotent purchase. The action forwards the price the payer
 * confirmed and the purchase's key (a malformed key is dropped, as on capacity/credits; a malformed
 * price is refused — never silently dropped). A refused price is `priceChanged` and re-renders the
 * page so the new price shows; the in-flight duplicate is a non-terminal `pending` — neither is
 * ever `ok`, neither is retried.
 */
describe("#2085 — topUpQuotaAction: confirmed price + idempotency key; 'price changed' and 'pending'", () => {
  const KEY = "5f9d1c2e-1a2b-4c3d-8e4f-0a1b2c3d4e5f";

  it("forwards the confirmed price and a well-formed key to the seam", async () => {
    topUpPostingQuota.mockResolvedValue({ posting: POSTING, addedViews: 10 });
    await topUpQuotaAction({ postingId: ID, tier: TIER, expectedPriceInr: 1000, idempotencyKey: KEY });
    expect(topUpPostingQuota).toHaveBeenCalledWith({
      postingId: ID,
      tier: TIER,
      expectedPriceInr: 1000,
      idempotencyKey: KEY,
    });
  });

  it("DROPS a malformed key (degrades to no-key) rather than forwarding junk", async () => {
    topUpPostingQuota.mockResolvedValue({ posting: POSTING, addedViews: 10 });
    await topUpQuotaAction({ postingId: ID, tier: TIER, expectedPriceInr: 1000, idempotencyKey: "not-a-uuid" });
    expect(topUpPostingQuota).toHaveBeenCalledWith({
      postingId: ID,
      tier: TIER,
      expectedPriceInr: 1000,
      idempotencyKey: undefined,
    });
  });

  it("a refused price is { priceChanged, currentPriceInr } and re-renders /postings with the new price", async () => {
    topUpPostingQuota.mockRejectedValue(new PriceMismatchError("/payer/job-postings/x/quota-topup", 750));
    const res = await topUpQuotaAction({ postingId: ID, tier: TIER, expectedPriceInr: 1000, idempotencyKey: KEY });
    expect(res).toEqual({ ok: false, priceChanged: true, currentPriceInr: 750 });
    expect(topUpPostingQuota).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/postings");
  });

  it("the in-flight duplicate is a non-terminal PENDING — never ok, never 'buy a plan first'", async () => {
    topUpPostingQuota.mockRejectedValue(new PurchaseConflictError());
    const res = await topUpQuotaAction({ postingId: ID, tier: TIER, expectedPriceInr: 1000, idempotencyKey: KEY });
    expect(res).toEqual({ ok: false, pending: true });
    expect(topUpPostingQuota).toHaveBeenCalledTimes(1);
  });

  it("a malformed confirmed price is refused before the seam", async () => {
    for (const bad of [-1, 999.5, "1000"]) {
      const res = await topUpQuotaAction({ postingId: ID, tier: TIER, expectedPriceInr: bad as number });
      expect(res, String(bad)).toEqual({ ok: false, error: PRICE_UNREADABLE_MESSAGE });
    }
    expect(topUpPostingQuota).not.toHaveBeenCalled();
  });
});

/**
 * #2085 L1 — the action threads the tier the payer confirmed. A missing or malformed tier is never
 * sent and never guessed (the seam no longer picks one); the seam's refusal of a changed tier is a
 * non-terminal `optionChanged` that re-renders the page so the current option shows.
 */
describe("#2085 L1 — topUpQuotaAction: the confirmed tier, or 'this option changed'", () => {
  it("a missing or malformed confirmed tier is refused before the seam", async () => {
    for (const bad of [
      undefined,
      { code: "", additionalViews: 10 },
      { code: "topup_10", additionalViews: 0 },
      { code: "topup_10", additionalViews: 2.5 },
      { code: "topup_10" },
    ]) {
      const res = await topUpQuotaAction({
        postingId: ID,
        tier: bad as unknown as typeof TIER,
        expectedPriceInr: 1000,
      });
      expect(res, JSON.stringify(bad)).toEqual({ ok: false, optionChanged: true });
    }
    expect(topUpPostingQuota).not.toHaveBeenCalled();
  });

  it("the seam's PurchaseOptionChangedError is { optionChanged } and re-renders /postings — never ok, never retried", async () => {
    topUpPostingQuota.mockRejectedValue(new PurchaseOptionChangedError());
    const res = await topUpQuotaAction({ postingId: ID, tier: TIER, expectedPriceInr: 1000 });
    expect(res).toEqual({ ok: false, optionChanged: true });
    expect(topUpPostingQuota).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/postings");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../../lib/payer-api", () => ({
  pausePosting: (i: unknown) => pausePosting(i),
  resumePosting: (i: unknown) => resumePosting(i),
  topUpPostingQuota: (i: unknown) => topUpPostingQuota(i),
  closePosting: (i: unknown) => closePosting(i),
  QuotaTopUpNoPlanError,
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { pausePostingAction, resumePostingAction, topUpQuotaAction, closePostingAction } =
  await import("./actions");

const ID = "bbbb2222-0000-4000-8000-000000000001";
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
    const res = await topUpQuotaAction({ postingId: ID });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.posting).toEqual(POSTING);
      expect(res.notice).toBe("Top-up applied — added 10 applicant views.");
    }
    expect(revalidatePath).toHaveBeenCalledWith("/postings");
  });

  it("a committed charge with a failed re-read is STILL ok (never 'please retry')", async () => {
    topUpPostingQuota.mockResolvedValue({ posting: null, addedViews: 10 });
    const res = await topUpQuotaAction({ postingId: ID });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.posting).toBeNull();
      expect(res.notice).toContain("refresh to see it");
      expect(res.notice).not.toMatch(/retry/i);
    }
  });

  it("QuotaTopUpNoPlanError → the actionable 'buy a plan first' copy", async () => {
    topUpPostingQuota.mockRejectedValue(new QuotaTopUpNoPlanError("no active plan"));
    const res = await topUpQuotaAction({ postingId: ID });
    expect(res).toEqual({
      ok: false,
      error: "This posting has no active plan yet — buy a plan first.",
    });
  });

  it("a null outcome (neutral 404 — the POST itself) maps to not-found, and a transport throw to retry copy", async () => {
    topUpPostingQuota.mockResolvedValue(null);
    expect(await topUpQuotaAction({ postingId: ID })).toEqual({
      ok: false,
      error: "That posting could not be found.",
    });
    topUpPostingQuota.mockRejectedValue(new Error("network"));
    expect(await topUpQuotaAction({ postingId: ID })).toEqual({
      ok: false,
      error: "Could not top up the quota right now. Please retry.",
    });
  });
});

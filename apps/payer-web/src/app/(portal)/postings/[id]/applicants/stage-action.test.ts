import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayerHttpError } from "../../../../../lib/payer-errors";

/**
 * setApplicantStageAction — the SAVED board's one write (#2139; API #2137).
 *
 * Pinned: the session gate runs FIRST (a rejection sends nothing); the input is validated (ids,
 * the three stages, no extra key) before any network; the client names only the posting, the
 * opaque worker and the stage (XB-A — the seam gets exactly those three); the server's stage is
 * what success returns; a failure is a REASON (gone / rate-limited / failed), never server text;
 * and ONLY the neutral 404 revalidates (a saved move needs no re-read — re-reads spend the reach
 * budget).
 */

const NEXT_REDIRECT = new Error("NEXT_REDIRECT");
const requirePayer = vi.fn();
const setApplicantStage = vi.fn();
const revalidatePath = vi.fn();

vi.mock("../../../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../../../lib/payer-api", () => ({
  setApplicantStage: (i: unknown) => setApplicantStage(i),
  requestUnlock: vi.fn(),
  reveal: vi.fn(),
  revealMaskedResume: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string, t?: string) => revalidatePath(p, t),
}));

const { setApplicantStageAction } = await import("./actions");

const P1 = "11111111-0000-4000-8000-000000000001";
const W1 = "aaaaaaaa-0000-4000-8000-000000000001";
const INPUT = { jobId: P1, workerId: W1, stage: "shortlist" as const };

const change = (over: Record<string, unknown> = {}) => ({
  postingId: P1,
  postingKind: "company_posting",
  workerId: W1,
  stage: "shortlist",
  previousStage: "new",
  changed: true,
  ...over,
});

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue({ payerId: "p1", role: "employer" });
  setApplicantStage.mockReset().mockResolvedValue(change());
  revalidatePath.mockReset();
});

describe("setApplicantStageAction — the session first, then a validated, ids-only call", () => {
  it("requirePayer runs FIRST: when it rejects (no session → /login) nothing is sent", async () => {
    requirePayer.mockRejectedValueOnce(NEXT_REDIRECT);
    await expect(setApplicantStageAction(INPUT)).rejects.toBe(NEXT_REDIRECT);
    expect(setApplicantStage).not.toHaveBeenCalled();
  });

  it("…and runs before the seam on every call", async () => {
    const order: string[] = [];
    requirePayer.mockImplementationOnce(async () => {
      order.push("session");
      return { payerId: "p1" };
    });
    setApplicantStage.mockImplementationOnce(async () => {
      order.push("seam");
      return change();
    });
    await setApplicantStageAction(INPUT);
    expect(order).toEqual(["session", "seam"]);
  });

  it("sends the seam exactly the posting, the worker and the stage — no payer id (XB-A)", async () => {
    await setApplicantStageAction(INPUT);
    expect(setApplicantStage).toHaveBeenCalledTimes(1);
    expect(setApplicantStage.mock.calls[0]![0]).toEqual(INPUT);
  });

  it("a malformed id, a stage outside the three or an extra key never reaches the API", async () => {
    for (const bad of [
      { ...INPUT, jobId: "not-an-id" },
      { ...INPUT, workerId: "w1" },
      { ...INPUT, stage: "archived" },
      { ...INPUT, payerId: "p2" },
    ]) {
      await expect(setApplicantStageAction(bad as never)).resolves.toEqual({
        ok: false,
        reason: "failed",
      });
    }
    expect(setApplicantStage).not.toHaveBeenCalled();
  });
});

describe("setApplicantStageAction — the answer", () => {
  it("success returns the stage the SERVER now holds, and whether it changed", async () => {
    await expect(setApplicantStageAction(INPUT)).resolves.toEqual({
      ok: true,
      stage: "shortlist",
      changed: true,
    });
    setApplicantStage.mockResolvedValueOnce(change({ previousStage: "shortlist", changed: false }));
    await expect(setApplicantStageAction(INPUT)).resolves.toEqual({
      ok: true,
      stage: "shortlist",
      changed: false,
    });
    // A saved move needs no re-read: nothing is revalidated.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("the neutral 404 is `gone` — and ONLY it revalidates the pages (the list is out of date)", async () => {
    setApplicantStage.mockResolvedValueOnce(null);
    await expect(setApplicantStageAction(INPUT)).resolves.toEqual({ ok: false, reason: "gone" });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("a 429 is `rate-limited`; anything else is `failed` — never the API's own words", async () => {
    setApplicantStage.mockRejectedValueOnce(new PayerHttpError("/payer/reach/jobs/x", 429));
    await expect(setApplicantStageAction(INPUT)).resolves.toEqual({
      ok: false,
      reason: "rate-limited",
    });
    setApplicantStage.mockRejectedValueOnce(new PayerHttpError("/payer/reach/jobs/x", 500));
    await expect(setApplicantStageAction(INPUT)).resolves.toEqual({ ok: false, reason: "failed" });
    setApplicantStage.mockRejectedValueOnce(new Error("answered for another row"));
    await expect(setApplicantStageAction(INPUT)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

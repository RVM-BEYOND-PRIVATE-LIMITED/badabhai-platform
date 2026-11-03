import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unlock Server Actions — a posting's (`unlockAction`) and the all-candidates search's
 * (`candidateUnlockAction`, ADR-0040 E2) — and the masked résumé with no posting.
 *
 * Pinned: the search unlock names the opaque worker id only and reaches the seam with
 * `postingId: null` (the wire's `job_id: null` — payer-api.test.ts pins the body); the posting
 * unlock still sends ITS posting exactly as before; both validate before any network and collapse
 * a failure to one retryable error; the résumé asked with no posting reaches the seam with none
 * (→ `job_posting_id: null`).
 */

const requestUnlock = vi.fn();
const revealMaskedResume = vi.fn();

vi.mock("../../../../../lib/auth", () => ({ requirePayer: vi.fn() }));
vi.mock("../../../../../lib/payer-api", () => ({
  requestUnlock: (i: unknown) => requestUnlock(i),
  reveal: vi.fn(),
  revealMaskedResume: (i: unknown) => revealMaskedResume(i),
  setApplicantStage: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { candidateUnlockAction, maskedResumeAction, unlockAction } = await import("./actions");

const P1 = "11111111-0000-4000-8000-000000000001";
const W1 = "face2000-0000-4000-8000-000000000001";
const UNLOCK = "44444444-4444-4444-8444-444444444444";
const GRANTED = { ok: true, unlockId: UNLOCK, status: "granted", expiresAt: "2026-12-01T00:00:00.000Z" };

beforeEach(() => {
  requestUnlock.mockReset().mockResolvedValue(GRANTED);
  revealMaskedResume.mockReset().mockResolvedValue({ status: "unavailable" });
});

describe("candidateUnlockAction — a search row's unlock: no posting, job_id null", () => {
  it("reaches the seam with the worker id and postingId NULL — nothing else", async () => {
    const res = await candidateUnlockAction({ workerId: W1 });
    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(requestUnlock.mock.calls[0]![0]).toStrictEqual({ postingId: null, workerId: W1 });
    expect(res).toEqual({
      ok: true,
      view: { kind: "granted", unlockId: UNLOCK, expiresAt: "2026-12-01T00:00:00.000Z" },
    });
  });

  it("never forwards anything else the client put in the call (XB-A: no payer id, no posting)", async () => {
    await candidateUnlockAction({ workerId: W1, payer_id: "x", postingId: P1 } as unknown as {
      workerId: string;
    });
    expect(requestUnlock.mock.calls[0]![0]).toStrictEqual({ postingId: null, workerId: W1 });
  });

  it("a worker id that is not a uuid never reaches the network", async () => {
    expect(await candidateUnlockAction({ workerId: "not-a-uuid" })).toEqual({
      ok: false,
      error: "Invalid request.",
    });
    expect(requestUnlock).not.toHaveBeenCalled();
  });

  it("a failed call is ONE retryable error, never a cause", async () => {
    requestUnlock.mockRejectedValueOnce(new Error("payer API /payer/unlocks returned 503"));
    expect(await candidateUnlockAction({ workerId: W1 })).toEqual({
      ok: false,
      error: "Unlock failed (service unavailable). Please retry.",
    });
  });

  it("the neutral body maps to the ONE unavailable view (no-oracle)", async () => {
    requestUnlock.mockResolvedValueOnce({ status: "unavailable" });
    const res = await candidateUnlockAction({ workerId: W1 });
    expect(res.ok && res.view.kind).toBe("unavailable");
  });
});

describe("unlockAction — a posting's unlock, unchanged", () => {
  it("still sends ITS posting as the job context", async () => {
    await unlockAction({ postingId: P1, workerId: W1 });
    expect(requestUnlock.mock.calls[0]![0]).toStrictEqual({ postingId: P1, workerId: W1 });
  });

  it("still refuses a missing or malformed posting id before any network", async () => {
    for (const postingId of ["", "nope", null as unknown as string]) {
      expect(await unlockAction({ postingId, workerId: W1 })).toEqual({
        ok: false,
        error: "Invalid request.",
      });
    }
    expect(requestUnlock).not.toHaveBeenCalled();
  });
});

describe("maskedResumeAction — asked with no posting (a search row)", () => {
  it("reaches the seam with NO posting id (the seam sends job_posting_id: null)", async () => {
    await maskedResumeAction({ unlockId: UNLOCK, workerId: W1 });
    expect(revealMaskedResume).toHaveBeenCalledTimes(1);
    const input = revealMaskedResume.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.postingId).toBeUndefined();
    expect(input).toMatchObject({ unlockId: UNLOCK, workerId: W1 });
  });
});

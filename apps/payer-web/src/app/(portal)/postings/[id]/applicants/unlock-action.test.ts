import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unlock Server Actions — a posting's (`unlockAction`) and the all-candidates search's
 * (`candidateUnlockAction`, ADR-0040 E2) — and the masked résumé with no posting.
 *
 * Pinned: the search unlock names the opaque worker id only and reaches the seam with
 * `postingId: null` (the wire's `job_id: null` — payer-api.test.ts pins the body); the posting
 * unlock still sends ITS posting exactly as before; both validate before any network and collapse
 * a failure to one retryable error; the résumé asked with no posting reaches the seam with none
 * (→ `job_posting_id: null`). A SAMPLE row (R74) is refused before the seam.
 *
 * #2585: a GRANT reads the payer's balance back (`GET /payer/credits`) and returns it with the
 * server's clock at that read (`readBack: { balance, asOf }`), so the screens and the shell's chip
 * update with no reload and rank it over any figure read before it; a neutral answer reads nothing;
 * a failed read is `readBack: null` beside the grant — never a computed figure, never a failed
 * unlock.
 */

const requestUnlock = vi.fn();
const revealMaskedResume = vi.fn();
const getCredits = vi.fn();

vi.mock("../../../../../lib/auth", () => ({ requirePayer: vi.fn() }));
vi.mock("../../../../../lib/payer-api", () => ({
  getCredits: () => getCredits(),
  requestUnlock: (i: unknown) => requestUnlock(i),
  reveal: vi.fn(),
  revealMaskedResume: (i: unknown) => revealMaskedResume(i),
  setApplicantStage: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { candidateUnlockAction, maskedResumeAction, unlockAction } = await import("./actions");
const { NEUTRAL_UNLOCK_MESSAGE } = await import("../../../../../lib/unlock-view");

const P1 = "11111111-0000-4000-8000-000000000001";
const W1 = "face2000-0000-4000-8000-000000000001";
const UNLOCK = "44444444-4444-4444-8444-444444444444";
const GRANTED = { ok: true, unlockId: UNLOCK, status: "granted", expiresAt: "2026-12-01T00:00:00.000Z" };

/** The portal server's clock (epoch ms) — pinned, so a read-back's `asOf` is exact. */
const NOW = 1_762_250_000_000;

beforeEach(() => {
  requestUnlock.mockReset().mockResolvedValue(GRANTED);
  revealMaskedResume.mockReset().mockResolvedValue({ status: "unavailable" });
  getCredits.mockReset().mockResolvedValue({ payerId: "p", balance: 4 });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks(); // the clock spy (vi.fn mocks above are re-armed in beforeEach)
});

describe("candidateUnlockAction — a search row's unlock: no posting, job_id null", () => {
  it("reaches the seam with the worker id and postingId NULL — nothing else", async () => {
    const res = await candidateUnlockAction({ workerId: W1, isSample: false });
    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(requestUnlock.mock.calls[0]![0]).toStrictEqual({ postingId: null, workerId: W1 });
    expect(res).toEqual({
      ok: true,
      view: { kind: "granted", unlockId: UNLOCK, expiresAt: "2026-12-01T00:00:00.000Z" },
      readBack: { balance: 4, asOf: NOW },
    });
  });

  it("never forwards anything else the client put in the call (XB-A: no payer id, no posting)", async () => {
    const smuggled = { workerId: W1, isSample: false, payer_id: "x", postingId: P1 };
    await candidateUnlockAction(smuggled as unknown as { workerId: string; isSample: boolean });
    expect(requestUnlock.mock.calls[0]![0]).toStrictEqual({ postingId: null, workerId: W1 });
  });

  it("a worker id that is not a uuid never reaches the network", async () => {
    expect(await candidateUnlockAction({ workerId: "not-a-uuid", isSample: false })).toEqual({
      ok: false,
      error: "Invalid request.",
    });
    expect(requestUnlock).not.toHaveBeenCalled();
  });

  it("a failed call is ONE retryable error, never a cause", async () => {
    requestUnlock.mockRejectedValueOnce(new Error("payer API /payer/unlocks returned 503"));
    expect(await candidateUnlockAction({ workerId: W1, isSample: false })).toEqual({
      ok: false,
      error: "Unlock failed (service unavailable). Please retry.",
    });
  });

  it("the neutral body maps to the ONE unavailable view (no-oracle)", async () => {
    requestUnlock.mockResolvedValueOnce({ status: "unavailable" });
    const res = await candidateUnlockAction({ workerId: W1, isSample: false });
    expect(res.ok && res.view.kind).toBe("unavailable");
  });

  it("a SAMPLE row (R74) is refused before any network — the API's own neutral view", async () => {
    const res = await candidateUnlockAction({ workerId: W1, isSample: true });
    expect(requestUnlock).not.toHaveBeenCalled();
    expect(getCredits).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      view: { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE },
      readBack: null,
    });
  });

  it("a missing or non-boolean sample flag is an invalid request, never a spend", async () => {
    for (const isSample of [undefined, "false", 0]) {
      const input = { workerId: W1, isSample } as unknown as { workerId: string; isSample: boolean };
      expect(await candidateUnlockAction(input)).toEqual({ ok: false, error: "Invalid request." });
    }
    expect(requestUnlock).not.toHaveBeenCalled();
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

describe("#2585 — a grant reads the balance back; nothing else does", () => {
  it("a grant returns the balance GET /payer/credits read AFTER it — the server's figure, and when", async () => {
    getCredits.mockResolvedValueOnce({ payerId: "p", balance: 0 });
    const res = await unlockAction({ postingId: P1, workerId: W1 });
    expect(res).toMatchObject({
      ok: true,
      view: { kind: "granted" },
      readBack: { balance: 0, asOf: NOW },
    });
    expect(getCredits).toHaveBeenCalledTimes(1);
    // Read after the spend, never before it (the debit is in the unlock's own transaction).
    expect(getCredits.mock.invocationCallOrder[0]!).toBeGreaterThan(
      requestUnlock.mock.invocationCallOrder[0]!,
    );
  });

  it("a re-grant the server did not debit reads back the SAME figure — nothing is subtracted here", async () => {
    getCredits.mockResolvedValueOnce({ payerId: "p", balance: 7 });
    expect(await candidateUnlockAction({ workerId: W1, isSample: false })).toMatchObject({
      readBack: { balance: 7, asOf: NOW },
    });
  });

  it("a neutral answer reads no balance (nothing granted, nothing spent)", async () => {
    requestUnlock.mockResolvedValueOnce({ status: "unavailable" });
    const res = await unlockAction({ postingId: P1, workerId: W1 });
    expect(res).toEqual({
      ok: true,
      view: { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE },
      readBack: null,
    });
    expect(getCredits).not.toHaveBeenCalled();
  });

  it("a failed read-back keeps the GRANT — readBack null, never an error or a guess", async () => {
    getCredits.mockRejectedValueOnce(new Error("payer API /payer/credits returned 503"));
    const res = await unlockAction({ postingId: P1, workerId: W1 });
    expect(res).toEqual({
      ok: true,
      view: { kind: "granted", unlockId: UNLOCK, expiresAt: "2026-12-01T00:00:00.000Z" },
      readBack: null,
    });
  });

  it("asOf is the server's clock as the read starts — after the spend, never the browser's", async () => {
    const clock = vi.mocked(Date.now);
    clock.mockReset();
    clock.mockReturnValueOnce(NOW + 5);
    await unlockAction({ postingId: P1, workerId: W1 });
    expect(clock).toHaveBeenCalledTimes(1);
    // Stamped once the unlock answered, before the balance read began.
    expect(clock.mock.invocationCallOrder[0]!).toBeGreaterThan(
      requestUnlock.mock.invocationCallOrder[0]!,
    );
    expect(clock.mock.invocationCallOrder[0]!).toBeLessThan(getCredits.mock.invocationCallOrder[0]!);
  });

  it("a failed unlock reads nothing either", async () => {
    requestUnlock.mockRejectedValueOnce(new Error("payer API /payer/unlocks returned 503"));
    expect((await unlockAction({ postingId: P1, workerId: W1 })).ok).toBe(false);
    expect(getCredits).not.toHaveBeenCalled();
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

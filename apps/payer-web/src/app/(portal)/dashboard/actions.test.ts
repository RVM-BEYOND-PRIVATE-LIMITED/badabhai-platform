import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayerConflictError, PayerHttpError } from "../../../lib/payer-errors";

/**
 * #2984 §4 — the answer Server Action.
 *
 * Pinned: `requirePayer()` runs FIRST (a Server Action is an independently invocable POST
 * endpoint); the input is `.strict()` (no payer/worker/posting/date slot); only the three
 * company outcomes reach the seam; a 404 is neutral `not_found`, a 429 `rate_limited`, an
 * in-flight 409 `in_flight`, and anything else retryable `unavailable`. Only a SUCCESS
 * revalidates — and only `/dashboard`.
 */

const calls: string[] = [];
const requirePayer = vi.fn();
const recordUnlockOutcome = vi.fn();
const revalidatePath = vi.fn();

vi.mock("../../../lib/auth", () => ({
  requirePayer: () => {
    calls.push("requirePayer");
    return requirePayer();
  },
}));
vi.mock("../../../lib/payer-api", () => ({
  recordUnlockOutcome: (input: unknown) => {
    calls.push("recordUnlockOutcome");
    return recordUnlockOutcome(input);
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    calls.push("revalidatePath");
    return revalidatePath(path);
  },
}));

const { recordUnlockOutcomeAction } = await import("./actions");

const UNLOCK_ID = "22222222-2222-4222-8222-222222222222";
const WORKER_ID = "44444444-4444-4444-8444-444444444444";
const RECORDED = {
  unlockId: UNLOCK_ID,
  workerId: WORKER_ID,
  outcome: "hired" as const,
  previousOutcome: "still_talking" as const,
  answeredAt: "2026-10-10T09:00:00.000Z",
  changed: true,
};

const input = {
  unlockId: UNLOCK_ID,
  outcome: "hired" as const,
  idempotencyKey: "answer-key-1",
};

beforeEach(() => {
  calls.length = 0;
  requirePayer.mockReset().mockResolvedValue({ payerId: "p", displayLabel: "Acme", role: "employer" });
  recordUnlockOutcome.mockReset().mockResolvedValue(RECORDED);
  revalidatePath.mockReset();
});

describe("gate — authorization precedes validation and the seam", () => {
  it("an unauthenticated caller reaches neither the seam nor revalidation", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    requirePayer.mockRejectedValueOnce(redirect);
    await expect(recordUnlockOutcomeAction(input)).rejects.toBe(redirect);
    expect(calls).toEqual(["requirePayer"]);
    expect(recordUnlockOutcome).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("runs requirePayer BEFORE the seam and before revalidation", async () => {
    await recordUnlockOutcomeAction(input);
    expect(calls).toEqual(["requirePayer", "recordUnlockOutcome", "revalidatePath"]);
  });
});

describe("validation — a strict, ids-only intent", () => {
  it.each([
    ["a malformed unlock id", { ...input, unlockId: "not-a-uuid" }],
    ["an unknown outcome", { ...input, outcome: "not_reached" }],
    ["a blank idempotency key", { ...input, idempotencyKey: "" }],
    ["an unknown key", { ...input, workerId: WORKER_ID }],
    ["a smuggled payer id", { ...input, payer_id: "x" }],
  ])("refuses %s before any network", async (_label, bad) => {
    const result = await recordUnlockOutcomeAction(
      bad as unknown as { unlockId: string; outcome: "hired"; idempotencyKey: string },
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(requirePayer).toHaveBeenCalledTimes(1);
    expect(recordUnlockOutcome).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("success — the recorded answer, dashboard only", () => {
  it("forwards exactly the intent and returns the recorded answer (no worker id to the client)", async () => {
    const result = await recordUnlockOutcomeAction(input);
    expect(recordUnlockOutcome).toHaveBeenCalledTimes(1);
    expect(recordUnlockOutcome.mock.calls[0]![0]).toStrictEqual({
      unlockId: UNLOCK_ID,
      outcome: "hired",
      idempotencyKey: "answer-key-1",
    });
    expect(result).toEqual({
      ok: true,
      unlockId: UNLOCK_ID,
      outcome: "hired",
      previousOutcome: "still_talking",
      answeredAt: "2026-10-10T09:00:00.000Z",
      changed: true,
    });
    expect(result).not.toHaveProperty("workerId");
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("a repeat answer is still a success (changed false) and revalidates", async () => {
    recordUnlockOutcome.mockResolvedValueOnce({ ...RECORDED, changed: false });
    expect(await recordUnlockOutcomeAction(input)).toMatchObject({ ok: true, changed: false });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });
});

describe("refusals — a closed reason union, never the API's text", () => {
  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
    [400, "invalid_request"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("a %i maps to %s", async (status, reason) => {
    recordUnlockOutcome.mockRejectedValueOnce(new PayerHttpError("/payer/unlocks/x/outcome", status));
    const result = await recordUnlockOutcomeAction(input);
    expect(result).toMatchObject({ ok: false, reason });
    expect(result).not.toHaveProperty("workerId");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a 409 (an answer already in flight) is retryable `in_flight`", async () => {
    recordUnlockOutcome.mockRejectedValueOnce(
      new PayerConflictError("/payer/unlocks/x/outcome", null, "in_flight"),
    );
    expect(await recordUnlockOutcomeAction(input)).toMatchObject({
      ok: false,
      reason: "in_flight",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("the copy stays neutral and names no backend detail", async () => {
    recordUnlockOutcome.mockRejectedValueOnce(new Error("payer API /payer/unlocks/x returned 503"));
    const result = await recordUnlockOutcomeAction(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toMatch(/503|payer API|worker|tenant/i);
  });
});

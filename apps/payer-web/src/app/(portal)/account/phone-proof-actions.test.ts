import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayerConflictError, PayerHttpError } from "../../../lib/payer-errors";

/**
 * "Confirm your number" actions (#2754 item 3) — one message per API refusal, and the verify
 * action always carries the caller's Idempotency-Key (the component owns its lifecycle).
 */

const requestPhoneProof = vi.fn();
const verifyPhoneProof = vi.fn();

vi.mock("../../../lib/payer-api", () => ({
  requestPhoneProof: () => requestPhoneProof(),
  verifyPhoneProof: (input: unknown) => verifyPhoneProof(input),
}));

const { requestPhoneProofAction, verifyPhoneProofAction } = await import("./phone-proof-actions");
const M = await import("./messages");

beforeEach(() => {
  requestPhoneProof.mockReset();
  verifyPhoneProof.mockReset();
});

describe("requestPhoneProofAction — the send step's refusals", () => {
  it("success threads the server's resend window through unchanged", async () => {
    requestPhoneProof.mockResolvedValue({ resendInSeconds: 45 });
    await expect(requestPhoneProofAction()).resolves.toEqual({ ok: true, resendInSeconds: 45 });
  });

  it.each([
    ["no_phone_on_account", M.PHONE_PROOF_NO_PHONE],
    ["phone_not_provable", M.PHONE_PROOF_NOT_PROVABLE],
  ])("409 %s → its own message", async (reason, copy) => {
    requestPhoneProof.mockRejectedValue(new PayerConflictError("/payer/me/phone-proof", null, reason));
    await expect(requestPhoneProofAction()).resolves.toEqual({
      ok: false,
      error: copy,
      reason,
    });
  });

  it.each([
    [429, M.PHONE_PROOF_RATE_LIMITED, "rate_limited"],
    [502, M.PHONE_PROOF_SMS_FAILED, "sms_failed"],
    [503, M.PHONE_PROOF_UNAVAILABLE, "unavailable"],
  ])("%d → its own message", async (status, copy, reason) => {
    requestPhoneProof.mockRejectedValue(new PayerHttpError("/payer/me/phone-proof", status));
    await expect(requestPhoneProofAction()).resolves.toEqual({ ok: false, error: copy, reason });
  });

  it("a network failure is the neutral unavailable copy", async () => {
    requestPhoneProof.mockRejectedValue(new Error("network"));
    await expect(requestPhoneProofAction()).resolves.toEqual({
      ok: false,
      error: M.PHONE_PROOF_UNAVAILABLE,
      reason: "unavailable",
    });
  });
});

describe("verifyPhoneProofAction — one message per verify refusal", () => {
  it("success sends { code, idempotencyKey } to the seam and returns only { ok: true }", async () => {
    verifyPhoneProof.mockResolvedValue(undefined);
    await expect(
      verifyPhoneProofAction({ code: "123456", idempotencyKey: "key-12345678" }),
    ).resolves.toEqual({ ok: true });
    expect(verifyPhoneProof).toHaveBeenCalledWith({
      code: "123456",
      idempotencyKey: "key-12345678",
    });
  });

  it("a malformed code never reaches the seam", async () => {
    await expect(
      verifyPhoneProofAction({ code: "123", idempotencyKey: "key-12345678" }),
    ).resolves.toEqual({ ok: false, error: M.PHONE_PROOF_WRONG_CODE, reason: "wrong_code" });
    expect(verifyPhoneProof).not.toHaveBeenCalled();
  });

  it("a malformed idempotency key never reaches the seam", async () => {
    await expect(verifyPhoneProofAction({ code: "123456", idempotencyKey: "short" })).resolves.toEqual(
      { ok: false, error: M.PHONE_PROOF_UNAVAILABLE, reason: "unavailable" },
    );
    expect(verifyPhoneProof).not.toHaveBeenCalled();
  });

  it("401 (wrong or expired code) → one message", async () => {
    verifyPhoneProof.mockRejectedValue(new PayerHttpError("/payer/me/phone-proof/verify", 401));
    await expect(
      verifyPhoneProofAction({ code: "123456", idempotencyKey: "key-12345678" }),
    ).resolves.toEqual({ ok: false, error: M.PHONE_PROOF_WRONG_CODE, reason: "wrong_code" });
  });

  it.each([
    ["phone_changed", M.PHONE_PROOF_PHONE_CHANGED],
    ["phone_linked_to_another_account", M.PHONE_PROOF_LINKED_ELSEWHERE],
    ["in_flight", M.PHONE_PROOF_IN_FLIGHT],
  ])("409 %s → its own message", async (reason, copy) => {
    verifyPhoneProof.mockRejectedValue(
      new PayerConflictError("/payer/me/phone-proof/verify", null, reason),
    );
    await expect(
      verifyPhoneProofAction({ code: "123456", idempotencyKey: "key-12345678" }),
    ).resolves.toEqual({ ok: false, error: copy, reason });
  });

  it.each([
    [429, M.PHONE_PROOF_RATE_LIMITED, "rate_limited"],
    [502, M.PHONE_PROOF_SMS_FAILED, "sms_failed"],
    [503, M.PHONE_PROOF_UNAVAILABLE, "unavailable"],
  ])("%d → its own message", async (status, copy, reason) => {
    verifyPhoneProof.mockRejectedValue(
      new PayerHttpError("/payer/me/phone-proof/verify", status),
    );
    await expect(
      verifyPhoneProofAction({ code: "123456", idempotencyKey: "key-12345678" }),
    ).resolves.toEqual({ ok: false, error: copy, reason });
  });
});

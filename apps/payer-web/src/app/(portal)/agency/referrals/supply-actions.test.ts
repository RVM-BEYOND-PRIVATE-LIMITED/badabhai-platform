import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgencyKyc } from "../../../../lib/contracts";

/**
 * Agency SUPPLY-money Server-Action tests (ADR-0022 Amendment 2, LIVE). Covers:
 *  - VERTICAL authz: requireAgent() runs FIRST on EVERY action (an employer's notFound()
 *    short-circuits before the seam is touched);
 *  - KYC input validation MIRRORS the DTO (a bad PAN/IFSC/bank/name is rejected at the
 *    boundary; the seam is not called) + PAN/IFSC are uppercased before the seam;
 *  - GATE: a `null` seam result (gated 404) → `{ ok:false, disabled:true }`, NOT an error;
 *  - payout: a blocked result is passed through; a thrown error is a neutral retry.
 */

const requireAgent = vi.fn();
const submitAgencyKyc = vi.fn();
const requestAgencyPayout = vi.fn();

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../../../lib/payer-api", () => ({
  submitAgencyKyc: (i: unknown) => submitAgencyKyc(i),
  requestAgencyPayout: () => requestAgencyPayout(),
}));

const { submitKycAction, requestPayoutAction } = await import("./supply-actions");

const KYC: AgencyKyc = {
  status: "pending",
  panLast4: "234F",
  bankLast4: "6789",
  rejectReason: null,
  updatedAt: "2026-07-23T00:00:00.000Z",
};
const VALID_KYC = {
  pan: "abcde1234f", // lower-case → must be uppercased before the seam
  bankAccount: "123456789",
  ifsc: "hdfc0001234",
  accountHolderName: "Acme Tools",
};

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue({ payerId: "p", role: "agent", displayLabel: "A" });
  submitAgencyKyc.mockReset().mockResolvedValue(KYC);
  requestAgencyPayout.mockReset();
});

describe("submitKycAction — vertical authz + validation", () => {
  it("calls requireAgent FIRST; an employer (throws) never reaches the seam", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(submitKycAction(VALID_KYC)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(submitAgencyKyc).not.toHaveBeenCalled();
  });

  it("rejects an invalid PAN without calling the seam", async () => {
    const res = await submitKycAction({ ...VALID_KYC, pan: "NOPE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/PAN/i);
    expect(submitAgencyKyc).not.toHaveBeenCalled();
  });

  it("rejects an invalid IFSC / short bank number / short name without calling the seam", async () => {
    expect((await submitKycAction({ ...VALID_KYC, ifsc: "BADIFSC" })).ok).toBe(false);
    expect((await submitKycAction({ ...VALID_KYC, bankAccount: "123" })).ok).toBe(false);
    expect((await submitKycAction({ ...VALID_KYC, accountHolderName: "A" })).ok).toBe(false);
    expect(submitAgencyKyc).not.toHaveBeenCalled();
  });

  it("uppercases PAN/IFSC before the seam and returns the masked status on success", async () => {
    const res = await submitKycAction(VALID_KYC);
    expect(res).toEqual({ ok: true, kyc: KYC });
    expect(submitAgencyKyc).toHaveBeenCalledWith({
      pan: "ABCDE1234F",
      bankAccount: "123456789",
      ifsc: "HDFC0001234",
      accountHolderName: "Acme Tools",
    });
  });

  it("maps a gated 404 (seam null) to { ok:false, disabled:true }, not an error", async () => {
    submitAgencyKyc.mockResolvedValueOnce(null);
    const res = await submitKycAction(VALID_KYC);
    expect(res).toMatchObject({ ok: false, disabled: true });
  });

  it("maps a thrown seam failure to a neutral retry message", async () => {
    submitAgencyKyc.mockRejectedValueOnce(new Error("boom"));
    const res = await submitKycAction(VALID_KYC);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/retry/i);
  });
});

describe("requestPayoutAction — vertical authz + gate + passthrough", () => {
  it("calls requireAgent FIRST; an employer never reaches the seam", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(requestPayoutAction()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requestAgencyPayout).not.toHaveBeenCalled();
  });

  it("threads a created request through on success", async () => {
    requestAgencyPayout.mockResolvedValueOnce({
      ok: true,
      requestId: "req_1",
      amountInr: 800,
      accrualCount: 30,
    });
    const res = await requestPayoutAction();
    expect(res).toEqual({ ok: true, requestId: "req_1", amountInr: 800, accrualCount: 30 });
  });

  it("passes a blocked result through (no fake success)", async () => {
    requestAgencyPayout.mockResolvedValueOnce({
      ok: false,
      blocked: true,
      reason: "below_threshold",
    });
    const res = await requestPayoutAction();
    expect(res).toEqual({ ok: false, blocked: true, reason: "below_threshold" });
  });

  it("maps a gated 404 (seam null) to { ok:false, disabled:true }", async () => {
    requestAgencyPayout.mockResolvedValueOnce(null);
    const res = await requestPayoutAction();
    expect(res).toEqual({ ok: false, disabled: true });
  });

  it("maps a thrown seam failure to a neutral retry message", async () => {
    requestAgencyPayout.mockRejectedValueOnce(new Error("boom"));
    const res = await requestPayoutAction();
    expect(res.ok).toBe(false);
    if (!res.ok && "error" in res) expect(res.error).toMatch(/retry/i);
  });
});

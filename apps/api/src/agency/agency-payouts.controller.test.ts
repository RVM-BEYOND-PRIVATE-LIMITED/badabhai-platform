import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { AgencyPayoutsController } from "./agency-payouts.controller";
import type { AgencyKycService } from "./agency-kyc.service";
import type { AgencyPayoutService } from "./agency-payout.service";

const PAYER: AuthenticatedPayer = { id: "11111111-1111-4111-8111-111111111111", sid: "s", role: "agent" };
const KYC_DTO = { pan: "ABCDE1234F", bank_account: "123456789012", ifsc: "HDFC0001234", account_holder_name: "Acme" };

function make() {
  const kyc = {
    submit: vi.fn().mockResolvedValue({ status: "pending", panLast4: "234F" }),
    getOwnView: vi.fn().mockResolvedValue({ status: "pending" }),
  } as unknown as AgencyKycService;
  const payouts = {
    getEarnings: vi.fn().mockResolvedValue({ requestableInr: 0 }),
    requestPayout: vi.fn().mockResolvedValue({ ok: true, requestId: "r", amountInr: 500, accrualCount: 1 }),
    listRequests: vi.fn().mockResolvedValue([{ id: "r", amountInr: 500, accrualCount: 1, status: "requested", createdAt: new Date(0) }]),
  } as unknown as AgencyPayoutService;
  return { ctrl: new AgencyPayoutsController(kyc, payouts), kyc, payouts };
}

describe("AgencyPayoutsController — the SESSION payer is the ONLY subject (XB-A)", () => {
  it("submitKyc dispatches the session payer id + the validated dto", async () => {
    const { ctrl, kyc } = make();
    await ctrl.submitKyc(KYC_DTO, PAYER);
    expect(kyc.submit).toHaveBeenCalledWith(PAYER.id, KYC_DTO);
  });

  it("getKyc reads the session payer's OWN masked status", async () => {
    const { ctrl, kyc } = make();
    await ctrl.getKyc(PAYER);
    expect(kyc.getOwnView).toHaveBeenCalledWith(PAYER.id);
  });

  it("getEarnings scopes to the session payer id", async () => {
    const { ctrl, payouts } = make();
    await ctrl.getEarnings(PAYER);
    expect(payouts.getEarnings).toHaveBeenCalledWith(PAYER.id);
  });

  it("requestPayout acts ONLY on the session payer id (no body id)", async () => {
    const { ctrl, payouts } = make();
    const out = await ctrl.requestPayout(PAYER);
    expect(payouts.requestPayout).toHaveBeenCalledWith(PAYER.id);
    expect(out).toMatchObject({ ok: true });
  });

  it("listPayouts returns the session payer's OWN requests (faceless projection)", async () => {
    const { ctrl, payouts } = make();
    const rows = await ctrl.listPayouts(PAYER);
    expect(payouts.listRequests).toHaveBeenCalledWith(PAYER.id);
    expect(rows[0]).toEqual({ id: "r", amountInr: 500, accrualCount: 1, status: "requested", createdAt: new Date(0) });
  });
});

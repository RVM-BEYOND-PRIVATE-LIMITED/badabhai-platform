import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ownScope } from "../payers/payer-tenant-scope.test-support";
import { AgencyPayoutsController } from "./agency-payouts.controller";
import type { AgencyKycService } from "./agency-kyc.service";
import type { AgencyPayoutService } from "./agency-payout.service";

const PAYER_ID = "11111111-1111-4111-8111-111111111111";
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

/**
 * The handlers take the tenant scope `PayerOrgRoleGuard` authorized on (`@CurrentTenantScope()`,
 * built from the SESSION payer — XB-A) and hand THAT scope to the service: no body/param id, and
 * no second resolution (ADR-0053 §5.2 rule 1; PR #2175 F1).
 */
describe("AgencyPayoutsController — the guard's scope is the ONLY subject (XB-A)", () => {
  it("submitKyc dispatches the session payer id + the validated dto", async () => {
    const { ctrl, kyc } = make();
    await ctrl.submitKyc(KYC_DTO, await ownScope(PAYER_ID));
    expect(kyc.submit).toHaveBeenCalledWith(await ownScope(PAYER_ID), KYC_DTO);
  });

  it("getKyc reads the session payer's OWN masked status", async () => {
    const { ctrl, kyc } = make();
    await ctrl.getKyc(await ownScope(PAYER_ID));
    expect(kyc.getOwnView).toHaveBeenCalledWith(await ownScope(PAYER_ID));
  });

  it("getEarnings scopes to the session payer id", async () => {
    const { ctrl, payouts } = make();
    await ctrl.getEarnings(await ownScope(PAYER_ID));
    expect(payouts.getEarnings).toHaveBeenCalledWith(await ownScope(PAYER_ID));
  });

  it("requestPayout acts ONLY on the session payer id (no body id)", async () => {
    const { ctrl, payouts } = make();
    const out = await ctrl.requestPayout(await ownScope(PAYER_ID));
    expect(payouts.requestPayout).toHaveBeenCalledWith(await ownScope(PAYER_ID));
    expect(out).toMatchObject({ ok: true });
  });

  it("listPayouts returns the session payer's OWN requests (faceless projection)", async () => {
    const { ctrl, payouts } = make();
    const rows = await ctrl.listPayouts(await ownScope(PAYER_ID));
    expect(payouts.listRequests).toHaveBeenCalledWith(await ownScope(PAYER_ID));
    expect(rows[0]).toEqual({ id: "r", amountInr: 500, accrualCount: 1, status: "requested", createdAt: new Date(0) });
  });
});

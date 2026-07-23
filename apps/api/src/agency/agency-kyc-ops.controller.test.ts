import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { AgencyKycOpsController } from "./agency-kyc-ops.controller";
import type { AgencyKycService } from "./agency-kyc.service";

const PAYER = "11111111-1111-4111-8111-111111111111";

function make() {
  const kyc = {
    listPendingForOps: vi.fn().mockResolvedValue([{ payerId: PAYER, status: "pending", panLast4: "234F" }]),
    verify: vi.fn().mockResolvedValue({ ok: true }),
    reject: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as AgencyKycService;
  return { ctrl: new AgencyKycOpsController(kyc), kyc };
}

describe("AgencyKycOpsController — ops verify queue (masked, path-param target)", () => {
  it("listPending returns the masked queue (no full PAN/bank)", async () => {
    const { ctrl } = make();
    const rows = await ctrl.listPending();
    expect(rows[0]).toMatchObject({ payerId: PAYER, panLast4: "234F" });
    expect(JSON.stringify(rows)).not.toContain("ABCDE1234F");
  });

  it("verify targets the PATH-param payer id", async () => {
    const { ctrl, kyc } = make();
    await ctrl.verify({ payerId: PAYER });
    expect(kyc.verify).toHaveBeenCalledWith(PAYER);
  });

  it("reject forwards the bounded reason CODE", async () => {
    const { ctrl, kyc } = make();
    await ctrl.reject({ payerId: PAYER }, { reason: "invalid_pan" });
    expect(kyc.reject).toHaveBeenCalledWith(PAYER, "invalid_pan");
  });
});

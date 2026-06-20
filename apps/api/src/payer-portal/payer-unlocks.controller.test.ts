import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";

const PAYER_A: AuthenticatedPayer = { id: "aaaaaaaa-0000-4000-8000-000000000001", sid: "sid-a" };
const CTX: RequestContext = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };
const WORKER = "cccccccc-0000-4000-8000-000000000003";
const UNLOCK = "dddddddd-0000-4000-8000-000000000004";

function makeCtrl() {
  const unlocks = {
    requestUnlock: vi.fn(async () => ({ ok: true })),
    reveal: vi.fn(async () => ({ channel: "in_app_relay" })),
    listByPayer: vi.fn(async () => ({ unlocks: [] })),
    getCredits: vi.fn(async () => ({ payer_id: PAYER_A.id, balance: 0 })),
  };
  const disclosureRate = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const ctrl = new PayerUnlocksController(unlocks as never, disclosureRate as never);
  return { ctrl, unlocks, disclosureRate };
}

/**
 * XB-A at the payer boundary: every action is bound to the SESSION payer (`req.payer.id`)
 * and the request body never supplies a `payer_id`. Proves a payer cannot act under
 * another payer's id from the edge — the chokepoint ownership (reveal) is proven in
 * unlocks.service.test.ts.
 */
describe("PayerUnlocksController — identity from the session, never the body (ADR-0019 XB-A)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("requestUnlock binds payer_id to the SESSION payer (the DTO carries no payer_id)", async () => {
    await d.ctrl.requestUnlock({ worker_id: WORKER, job_id: null }, PAYER_A, CTX);
    expect(d.unlocks.requestUnlock).toHaveBeenCalledWith(
      { payerId: PAYER_A.id, workerId: WORKER, jobId: null },
      CTX,
    );
  });

  it("reveal forwards the SESSION payer as the ownership key (expectedPayerId)", async () => {
    await d.ctrl.reveal(UNLOCK, PAYER_A, CTX);
    expect(d.unlocks.reveal).toHaveBeenCalledWith(UNLOCK, CTX, PAYER_A.id);
  });

  it("listOwn + ownCredits scope to the SESSION payer", async () => {
    await d.ctrl.listOwn(PAYER_A);
    expect(d.unlocks.listByPayer).toHaveBeenCalledWith(PAYER_A.id);
    await d.ctrl.ownCredits(PAYER_A);
    expect(d.unlocks.getCredits).toHaveBeenCalledWith(PAYER_A.id);
  });

  it("enforces the per-payer disclosure cap (XB-G) against the SESSION payer on request + reveal", async () => {
    await d.ctrl.requestUnlock({ worker_id: WORKER, job_id: null }, PAYER_A, CTX);
    await d.ctrl.reveal(UNLOCK, PAYER_A, CTX);
    expect(d.disclosureRate.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER_A.id);
    expect(d.disclosureRate.assertWithinHourlyCap).toHaveBeenCalledTimes(2);
  });

  it("a tripped per-payer cap (XB-G) blocks the chokepoint (request never reaches UnlockService)", async () => {
    d.disclosureRate.assertWithinHourlyCap.mockRejectedValueOnce(new Error("429"));
    await expect(d.ctrl.requestUnlock({ worker_id: WORKER, job_id: null }, PAYER_A, CTX)).rejects.toThrow();
    expect(d.unlocks.requestUnlock).not.toHaveBeenCalled();
  });
});

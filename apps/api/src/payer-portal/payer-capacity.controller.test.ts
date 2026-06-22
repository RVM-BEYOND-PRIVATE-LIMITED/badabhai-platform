import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayerCapacityController } from "./payer-capacity.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";
import type { BuyCapacityDto } from "../posting-plans/posting-plans.dto";

const PAYER_A: AuthenticatedPayer = { id: "aaaaaaaa-0000-4000-8000-000000000001", sid: "sid-a" };
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};

function makeCtrl() {
  const plans = {
    getCapacity: vi.fn(async () => ({
      payer_id: PAYER_A.id,
      max_active_vacancies: 3,
      source_tier: null,
      expires_at: null,
    })),
    buyCapacity: vi.fn(async () => ({
      payer_id: PAYER_A.id,
      max_active_vacancies: 10,
      source_tier: "growth",
      expires_at: null,
      resumed_plan_ids: [],
    })),
  };
  const ctrl = new PayerCapacityController(plans as never);
  return { ctrl, plans };
}

/**
 * XB-A at the payer-capacity boundary: both reads and the buy are bound to the SESSION
 * payer (`req.payer.id`). There is no `:payerId` param and the body never supplies a
 * `payer_id` — a payer can never view or buy capacity under another payer's id.
 */
describe("PayerCapacityController — identity from the session, never a param/body (ADR-0019 XB-A)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("ownCapacity scopes to the SESSION payer", async () => {
    await d.ctrl.ownCapacity(PAYER_A);
    expect(d.plans.getCapacity).toHaveBeenCalledWith(PAYER_A.id);
  });

  it("buyCapacity delegates with the SESSION payer.id (the DTO carries no payer_id)", async () => {
    const dto: BuyCapacityDto = { tier: "growth" };
    await d.ctrl.buyCapacity(dto, PAYER_A, CTX);
    expect(d.plans.buyCapacity).toHaveBeenCalledWith(PAYER_A.id, dto, CTX);
  });
});

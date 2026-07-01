import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PostingPlansController } from "./posting-plans.controller";
import type { PostingPlansService } from "./posting-plans.service";
import type { RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const ID = "11111111-1111-4111-8111-111111111111";

function make() {
  const plans = {
    buyPlan: vi.fn(async () => ({ ok: true })),
    buyBoost: vi.fn(async () => ({ ok: true })),
  };
  return {
    controller: new PostingPlansController(plans as unknown as PostingPlansService),
    plans,
  };
}

describe("PostingPlansController (thin) — delegation", () => {
  it("buyPlan delegates id + dto + ctx", async () => {
    const { controller, plans } = make();
    const dto = { plan_code: "p1", payer_id: ID };
    await controller.buyPlan(ID, dto as never, CTX);
    expect(plans.buyPlan).toHaveBeenCalledWith(ID, dto, CTX);
  });

  it("buyBoost delegates id + dto + ctx", async () => {
    const { controller, plans } = make();
    const dto = { boost_code: "b1", payer_id: ID };
    await controller.buyBoost(ID, dto as never, CTX);
    expect(plans.buyBoost).toHaveBeenCalledWith(ID, dto, CTX);
  });

  // A2 (LC-1/TD33): these are money routes. They must NOT be open — the class-level
  // InternalServiceGuard is the regression net that closes the earlier IDOR vector
  // (open route trusting body payer_id). guard-contract.test.ts asserts the same at
  // the route level; this keeps the check local to the controller too.
  it("is guarded at the class level by InternalServiceGuard", () => {
    const guards = (Reflect.getMetadata("__guards__", PostingPlansController) ?? []) as Array<
      new (...a: never[]) => object
    >;
    expect(guards).toContain(InternalServiceGuard);
  });
});

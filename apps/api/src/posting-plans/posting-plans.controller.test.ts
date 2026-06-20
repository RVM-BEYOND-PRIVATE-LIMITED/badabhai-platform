import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PostingPlansController } from "./posting-plans.controller";
import type { PostingPlansService } from "./posting-plans.service";
import type { RequestContext } from "../common/request-context";

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
});

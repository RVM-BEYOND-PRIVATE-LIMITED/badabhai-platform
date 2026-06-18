import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { CapacityController } from "./capacity.controller";
import type { PostingPlansService } from "./posting-plans.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PAYER = "11111111-1111-4111-8111-111111111111";

function make() {
  const plans = { buyCapacity: vi.fn(async () => ({ ok: true })) };
  return { controller: new CapacityController(plans as unknown as PostingPlansService), plans };
}

describe("CapacityController (thin, internal) — delegation", () => {
  it("buyCapacity delegates payerId + dto + ctx", async () => {
    const { controller, plans } = make();
    const dto = { units: 5, pack_code: "cap_5" };
    await controller.buyCapacity(PAYER, dto as never, CTX);
    expect(plans.buyCapacity).toHaveBeenCalledWith(PAYER, dto, CTX);
  });
});

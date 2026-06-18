import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ActionsController } from "./actions.controller";
import type { ActionsService } from "./actions.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;

function make() {
  const actions = {
    record: vi.fn(async () => ({ recorded: 1 })),
    recordBatch: vi.fn(async () => ({ recorded: 3 })),
  };
  return { controller: new ActionsController(actions as unknown as ActionsService), actions };
}

describe("ActionsController (thin) — delegation", () => {
  it("record delegates the dto + ctx to the service", async () => {
    const { controller, actions } = make();
    const dto = { action: "viewed", worker_id: "w" };
    await controller.record(dto as never, CTX);
    expect(actions.record).toHaveBeenCalledWith(dto, CTX);
  });

  it("recordBatch delegates the batch dto + ctx to the service", async () => {
    const { controller, actions } = make();
    const dto = { actions: [{ action: "viewed" }] };
    await controller.recordBatch(dto as never, CTX);
    expect(actions.recordBatch).toHaveBeenCalledWith(dto, CTX);
  });
});

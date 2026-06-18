import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { UnlocksController } from "./unlocks.controller";
import type { UnlockService } from "./unlocks.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PAYER = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const UNLOCK = "44444444-4444-4444-8444-444444444444";

function make() {
  const unlocks = {
    requestUnlock: vi.fn(async () => ({ ok: true, status: "neutral" })),
    reveal: vi.fn(async () => ({ relay_handle: "relay_x", channel: "whatsapp" })),
    listByPayer: vi.fn(async () => ({ unlocks: [] })),
    getOne: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    getCredits: vi.fn(async () => ({ balance: 5 })),
    purchaseCredits: vi.fn(async () => null as Record<string, unknown> | null),
  };
  return { controller: new UnlocksController(unlocks as unknown as UnlockService), unlocks };
}

describe("UnlocksController (internal) — delegation + 404 ops paths", () => {
  it("requestUnlock maps the body to the service shape", async () => {
    const { controller, unlocks } = make();
    await controller.requestUnlock({ payer_id: PAYER, worker_id: WORKER, job_id: JOB } as never, CTX);
    expect(unlocks.requestUnlock).toHaveBeenCalledWith(
      { payerId: PAYER, workerId: WORKER, jobId: JOB },
      CTX,
    );
  });

  it("reveal delegates the unlockId + ctx", async () => {
    const { controller, unlocks } = make();
    await controller.reveal(UNLOCK, CTX);
    expect(unlocks.reveal).toHaveBeenCalledWith(UNLOCK, CTX);
  });

  it("listUnlocks delegates the payer_id from the query", async () => {
    const { controller, unlocks } = make();
    await controller.listUnlocks({ payer_id: PAYER } as never);
    expect(unlocks.listByPayer).toHaveBeenCalledWith(PAYER);
  });

  it("getUnlock 404s when the unlock is unknown (ops route, not the no-oracle path)", async () => {
    const { controller } = make();
    await expect(controller.getUnlock(UNLOCK)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getUnlock returns the projection when found", async () => {
    const { controller, unlocks } = make();
    unlocks.getOne.mockResolvedValueOnce({ unlock_id: UNLOCK, status: "granted" });
    const res = await controller.getUnlock(UNLOCK);
    expect(res).toEqual({ unlock_id: UNLOCK, status: "granted" });
  });

  it("getCredits delegates the payerId", async () => {
    const { controller, unlocks } = make();
    await controller.getCredits(PAYER);
    expect(unlocks.getCredits).toHaveBeenCalledWith(PAYER);
  });

  it("purchaseCredits 404s on an unknown pack_code", async () => {
    const { controller } = make();
    await expect(
      controller.purchaseCredits(PAYER, { pack_code: "nope" } as never, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("purchaseCredits returns the result for a known pack", async () => {
    const { controller, unlocks } = make();
    unlocks.purchaseCredits.mockResolvedValueOnce({ balance: 15 });
    const res = await controller.purchaseCredits(PAYER, { pack_code: "pack_10" } as never, CTX);
    expect(unlocks.purchaseCredits).toHaveBeenCalledWith(PAYER, "pack_10", CTX);
    expect(res).toEqual({ balance: 15 });
  });
});

import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { UnlocksController } from "./unlocks.controller";
import type { UnlockService } from "./unlocks.service";
import type { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PAYER = "11111111-1111-4111-8111-111111111111";
const OTHER_PAYER = "99999999-9999-4999-8999-999999999999";
const WORKER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const UNLOCK = "44444444-4444-4444-8444-444444444444";
const SESSION: AuthenticatedPayer = { id: PAYER, sid: "sid-1" };

function make() {
  const unlocks = {
    requestUnlock: vi.fn(async () => ({ ok: true, status: "neutral" })),
    reveal: vi.fn(async () => ({ relay_handle: "relay_x", channel: "in_app_relay" })),
    listByPayer: vi.fn(async () => ({ unlocks: [] })),
    getOne: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    getCredits: vi.fn(async () => ({ payer_id: PAYER, balance: 5 })),
    purchaseCredits: vi.fn(async () => null as Record<string, unknown> | null),
  };
  const disclosureRate = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const controller = new UnlocksController(
    unlocks as unknown as UnlockService,
    disclosureRate as unknown as PayerDisclosureRateLimit,
  );
  return { controller, unlocks, disclosureRate };
}

describe("UnlocksController (self-serve payer surface) — session-bound delegation + XB-A", () => {
  it("requestUnlock binds payer_id to the SESSION (never the body) + applies the XB-G cap first", async () => {
    const { controller, unlocks, disclosureRate } = make();
    await controller.requestUnlock({ worker_id: WORKER, job_id: JOB } as never, SESSION, CTX);
    expect(disclosureRate.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER);
    expect(unlocks.requestUnlock).toHaveBeenCalledWith(
      { payerId: PAYER, workerId: WORKER, jobId: JOB },
      CTX,
    );
  });

  it("reveal delegates unlockId + ctx + the SESSION payer (expectedPayerId for no-oracle ownership)", async () => {
    const { controller, unlocks, disclosureRate } = make();
    await controller.reveal(UNLOCK, SESSION, CTX);
    expect(disclosureRate.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER);
    expect(unlocks.reveal).toHaveBeenCalledWith(UNLOCK, CTX, PAYER);
  });

  it("listOwn scopes to the session payer (no caller-supplied payer_id)", async () => {
    const { controller, unlocks } = make();
    await controller.listOwn(SESSION);
    expect(unlocks.listByPayer).toHaveBeenCalledWith(PAYER);
  });

  it("getOwn returns the projection when the caller OWNS it", async () => {
    const { controller, unlocks } = make();
    unlocks.getOne.mockResolvedValueOnce({ unlock_id: UNLOCK, status: "granted", payer_id: PAYER });
    const res = await controller.getOwn(UNLOCK, SESSION);
    expect(res).toMatchObject({ unlock_id: UNLOCK, status: "granted" });
  });

  it("getOwn 404s identically for an UNKNOWN unlock and ANOTHER payer's unlock (no-oracle)", async () => {
    const { controller, unlocks } = make();
    // unknown
    unlocks.getOne.mockResolvedValueOnce(undefined);
    await expect(controller.getOwn(UNLOCK, SESSION)).rejects.toBeInstanceOf(NotFoundException);
    // not-owned (belongs to another payer) → SAME NotFoundException, never a 403/leak
    unlocks.getOne.mockResolvedValueOnce({ unlock_id: UNLOCK, status: "granted", payer_id: OTHER_PAYER });
    await expect(controller.getOwn(UNLOCK, SESSION)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("ownCredits returns the SESSION balance when the :payerId param matches", async () => {
    const { controller, unlocks } = make();
    await controller.ownCredits(PAYER, SESSION);
    expect(unlocks.getCredits).toHaveBeenCalledWith(PAYER);
  });

  it("ownCredits REJECTS (403) a cross-payer read (param != session)", async () => {
    const { controller, unlocks } = make();
    expect(() => controller.ownCredits(OTHER_PAYER, SESSION)).toThrow(ForbiddenException);
    expect(unlocks.getCredits).not.toHaveBeenCalled();
  });

  it("purchaseCredits is a SELF-purchase bound to the session — uses payer.id, not the param", async () => {
    const { controller, unlocks } = make();
    unlocks.purchaseCredits.mockResolvedValueOnce({ payer_id: PAYER, balance: 15 });
    const res = await controller.purchaseCredits(PAYER, { pack_code: "pack_10" } as never, SESSION, CTX);
    expect(unlocks.purchaseCredits).toHaveBeenCalledWith(PAYER, "pack_10", CTX);
    expect(res).toMatchObject({ balance: 15 });
  });

  it("XB-A BLOCKER: purchaseCredits REJECTS buying credits against ANOTHER payer's id (403, no debit)", async () => {
    const { controller, unlocks } = make();
    await expect(
      controller.purchaseCredits(OTHER_PAYER, { pack_code: "pack_10" } as never, SESSION, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(unlocks.purchaseCredits).not.toHaveBeenCalled();
  });

  it("purchaseCredits 404s on an unknown pack_code (self-purchase, not the no-oracle path)", async () => {
    const { controller } = make();
    await expect(
      controller.purchaseCredits(PAYER, { pack_code: "nope" } as never, SESSION, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

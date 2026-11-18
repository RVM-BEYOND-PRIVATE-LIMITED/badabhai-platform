import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { ReachDeskDeadlineProcessor, REACH_DEADLINE_SWEEP_BATCH } from "./reach-desk-deadline.processor";
import { PayerReachController } from "./payer-reach.controller";

/**
 * #2750 item 7 — the company's couldn't-reach routes are behind the payer session, act for the
 * session's login only, and the deadline processor hands each tick to the service.
 */
const UNLOCK = "u0000000-0000-4000-8000-000000000001";
const CTX = { correlationId: "corr" } as never;

describe("PayerReachController", () => {
  it("is behind PayerAuthGuard at the class level, with exactly the report and the read", () => {
    const guards = (Reflect.getMetadata("__guards__", PayerReachController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([PayerAuthGuard.name]);
    const methods = Object.getOwnPropertyNames(PayerReachController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual(["get", "report"]);
  });

  it("acts for the session's login, never a body field", async () => {
    const desk = { report: vi.fn(async () => ({})), getForPayer: vi.fn(async () => ({})) };
    const c = new PayerReachController(desk as never);
    await c.report(UNLOCK, { id: "session-payer" } as never, CTX);
    expect(desk.report).toHaveBeenCalledWith("session-payer", UNLOCK, CTX);
    await c.get(UNLOCK, { id: "session-payer" } as never);
    expect(desk.getForPayer).toHaveBeenCalledWith("session-payer", UNLOCK);
  });
});

describe("ReachDeskDeadlineProcessor", () => {
  it("each tick sweeps one batch through the service", async () => {
    const desk = {
      sweepDeadlines: vi.fn(async () => ({ skipped: false, due: 1, closed: 1, failed: 0 })),
    };
    const p = new ReachDeskDeadlineProcessor(desk as never, { upsertJobScheduler: vi.fn() } as never);
    expect(await p.process()).toEqual({ skipped: false, due: 1, closed: 1, failed: 0 });
    expect(desk.sweepDeadlines).toHaveBeenCalledWith(REACH_DEADLINE_SWEEP_BATCH);
  });

  it("registers its repeatable tick at boot, and survives a registration failure", async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new ReachDeskDeadlineProcessor({} as never, queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith("reach-desk-deadline-sweep", {
      every: 15 * 60 * 1000,
    });
    const failing = { upsertJobScheduler: vi.fn(async () => Promise.reject(new Error("redis"))) };
    await expect(
      new ReachDeskDeadlineProcessor({} as never, failing as never).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});

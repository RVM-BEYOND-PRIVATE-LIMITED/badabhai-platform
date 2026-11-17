import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";

import {
  NUMBERS_WEEKLY_SWEEP_QUEUE,
  NUMBERS_WEEKLY_SWEEP_SCHEDULER_ID,
} from "../../queue/queue.constants";
import type { NumbersSnapshotService } from "./numbers-snapshot.service";
import { NUMBERS_WEEKLY_SWEEP_EVERY_MS, NumbersSweepProcessor } from "./numbers-sweep.processor";

/**
 * #2755 item 4 — the sweep's clock: a payload-free repeatable job registered at boot with
 * `upsertJobScheduler` (idempotent by id, daily), never failing boot, and a tick that is the
 * service's `sweep`. What a tick does is `numbers-snapshot.service.test.ts` and the DB gate's.
 */
afterEach(() => vi.restoreAllMocks());

function setup(upsert: () => Promise<unknown> = async () => undefined) {
  const queue = { upsertJobScheduler: vi.fn(upsert) };
  const snapshot = {
    sweep: vi.fn(async () => ({ armed: true, computed: 2, frozen: 1, skipped: 20 })),
  };
  const processor = new NumbersSweepProcessor(
    snapshot as unknown as NumbersSnapshotService,
    queue as unknown as Queue,
  );
  return { queue, snapshot, processor };
}

describe("NumbersSweepProcessor", () => {
  it("is on its own queue", () => {
    expect(NUMBERS_WEEKLY_SWEEP_QUEUE).toBe("numbers-weekly-sweep");
  });

  it("registers ONE daily scheduler by its stable id, with no payload", async () => {
    const { queue, processor } = setup();
    await processor.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(NUMBERS_WEEKLY_SWEEP_SCHEDULER_ID, {
      every: 24 * 60 * 60 * 1000,
    });
    expect(NUMBERS_WEEKLY_SWEEP_EVERY_MS).toBe(86_400_000);
    expect(queue.upsertJobScheduler.mock.calls[0]).toHaveLength(2);
  });

  it("a registration failure logs one warning (the error's class, never its text) and never fails boot", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { processor } = setup(async () => {
      throw new TypeError("redis://user:secret@host refused");
    });
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("TypeError");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it("a tick is the service's sweep, and returns its counts", async () => {
    const { snapshot, processor } = setup();
    expect(await processor.process()).toEqual({ armed: true, computed: 2, frozen: 1, skipped: 20 });
    expect(snapshot.sweep).toHaveBeenCalledTimes(1);
  });
});

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";

import {
  STILL_LOOKING_SWEEP_QUEUE,
  STILL_LOOKING_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import type { StillLookingService } from "./still-looking.service";
import {
  STILL_LOOKING_SWEEP_EVERY_MS,
  StillLookingSweepProcessor,
} from "./still-looking.sweep.processor";

/**
 * #2753 item 5 — the sweep's clock: a payload-free repeatable job registered at boot with
 * `upsertJobScheduler` (idempotent by id, daily), never failing boot, and a tick that is the
 * service's `sweep`. What a tick does is `still-looking.service.test.ts` and the DB gate's.
 */
afterEach(() => vi.restoreAllMocks());

function setup(upsert: () => Promise<unknown> = async () => undefined) {
  const queue = { upsertJobScheduler: vi.fn(upsert) };
  const service = { sweep: vi.fn(async () => ({ armed: true, opened: 3, pushed: 0 })) };
  const processor = new StillLookingSweepProcessor(
    service as unknown as StillLookingService,
    queue as unknown as Queue,
  );
  return { queue, service, processor };
}

describe("StillLookingSweepProcessor", () => {
  it("registers ONE daily scheduler by its stable id, with no payload", async () => {
    const { queue, processor } = setup();
    await processor.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(STILL_LOOKING_SWEEP_SCHEDULER_ID, {
      every: 24 * 60 * 60 * 1000,
    });
    expect(STILL_LOOKING_SWEEP_EVERY_MS).toBe(86_400_000);
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
    const { service, processor } = setup();
    expect(await processor.process()).toEqual({ armed: true, opened: 3, pushed: 0 });
    expect(service.sweep).toHaveBeenCalledTimes(1);
  });

  it("listens on its own queue", () => {
    expect(STILL_LOOKING_SWEEP_QUEUE).toBe("still-looking-sweep");
  });
});

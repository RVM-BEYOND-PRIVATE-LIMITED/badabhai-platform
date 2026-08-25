import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReachWidenExpirySweepProcessor } from "./reach-widen-expiry-sweep.processor";

/**
 * Unit tests for the Policy 27 widen-expiry sweep processor (TD127). The processor is a
 * thin shell — registration + dry-run gate + batch bound + count logs — around
 * PublishReachService.retractExpiredWidens, which carries the actual semantics and has
 * its own suite. These pin the SHELL: what runs when, and that disarmed means inert.
 */

function makeProcessor(opts: {
  enabled: boolean;
  intervalHours?: number;
  batchLimit?: number;
  due?: number;
  retractSummary?: {
    grantsRetracted: number;
    postingsShrunk: number;
    postingsSkippedNotLive: number;
  };
}) {
  const publishReach = {
    countDueWidenGrants: vi.fn(async () => opts.due ?? 0),
    retractExpiredWidens: vi.fn(
      async (_limit: number) =>
        opts.retractSummary ?? { grantsRetracted: 0, postingsShrunk: 0, postingsSkippedNotLive: 0 },
    ),
  };
  const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
  const config = {
    REACH_WIDEN_EXPIRY_ENABLED: opts.enabled,
    REACH_WIDEN_EXPIRY_SWEEP_INTERVAL_HOURS: opts.intervalHours ?? 1,
    REACH_WIDEN_EXPIRY_BATCH_LIMIT: opts.batchLimit ?? 100,
  };
  const processor = new ReachWidenExpirySweepProcessor(
    publishReach as never,
    queue as never,
    config as never,
  );
  return { processor, publishReach, queue };
}

describe("ReachWidenExpirySweepProcessor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers ONE repeatable scheduler at boot with the configured cadence", async () => {
    const { processor, queue } = makeProcessor({ enabled: false, intervalHours: 2 });
    await processor.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [id, pattern] = queue.upsertJobScheduler.mock.calls[0] as unknown as [
      string,
      { every: number },
    ];
    expect(id).toBe("reach-widen-expiry-sweep");
    // 2 hours in ms — the scheduler id must stay stable across boots (the /health probe
    // doctrine), while cadence UPDATES ride the same id.
    expect(pattern.every).toBe(7_200_000);
  });

  it("a failed registration WARNS but never fails boot", async () => {
    const { processor, queue } = makeProcessor({ enabled: true });
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("DISARMED (dry-run): reports the due count and retracts nothing", async () => {
    const { processor, publishReach } = makeProcessor({ enabled: false, due: 7 });
    const result = await processor.process();

    expect(result).toEqual({
      dryRun: true,
      dueGrants: 7,
      grantsRetracted: 0,
      postingsShrunk: 0,
      postingsSkippedNotLive: 0,
    });
    expect(publishReach.retractExpiredWidens).not.toHaveBeenCalled();
  });

  it("ARMED: retracts one bounded batch through the service", async () => {
    const summary = { grantsRetracted: 3, postingsShrunk: 2, postingsSkippedNotLive: 1 };
    const { processor, publishReach } = makeProcessor({
      enabled: true,
      due: 3,
      batchLimit: 50,
      retractSummary: summary,
    });
    const result = await processor.process();

    expect(publishReach.retractExpiredWidens).toHaveBeenCalledWith(50);
    expect(result).toEqual({ dryRun: false, dueGrants: 3, ...summary });
  });
});

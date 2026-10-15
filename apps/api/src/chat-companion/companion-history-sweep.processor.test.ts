import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { COMPANION_HISTORY_SWEEP_SCHEDULER_ID } from "../queue/queue.constants";
import {
  COMPANION_HISTORY_SWEEP_EVERY_MS,
  CompanionHistorySweepProcessor,
} from "./companion-history-sweep.processor";

/** #2297 (ADR-0056) — the daily retention tick: registered once a day, a clock and nothing more. */

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function setup(result = { linesDeleted: 12, summariesDeleted: 2, tablesMissing: false }) {
  const history = { sweep: vi.fn(async (_now: Date) => result) };
  const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
  const processor = new CompanionHistorySweepProcessor(history as never, queue as never);
  return { processor, history, queue };
}

describe("CompanionHistorySweepProcessor", () => {
  it("registers ONE daily scheduler at boot, idempotent by id", async () => {
    const h = setup();
    await h.processor.onApplicationBootstrap();
    expect(h.queue.upsertJobScheduler).toHaveBeenCalledWith(COMPANION_HISTORY_SWEEP_SCHEDULER_ID, {
      every: 86_400_000,
    });
    expect(COMPANION_HISTORY_SWEEP_EVERY_MS).toBe(86_400_000);
  });

  it("a registration failure never fails boot", async () => {
    const h = setup();
    h.queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
    await expect(h.processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("one tick runs the sweep and logs counts only", async () => {
    const h = setup();
    expect(await h.processor.process()).toEqual({
      linesDeleted: 12,
      summariesDeleted: 2,
      tablesMissing: false,
    });
    expect(h.history.sweep).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls.at(-1)?.[0])).toBe(
      "companion history sweep: lines_deleted=12 summaries_deleted=2",
    );
  });

  it("before migration 0135 a tick says so and sweeps nothing", async () => {
    const h = setup({ linesDeleted: 0, summariesDeleted: 0, tablesMissing: true });
    await h.processor.process();
    expect(String(log.mock.calls.at(-1)?.[0])).toContain("migration 0135 not applied");
  });
});

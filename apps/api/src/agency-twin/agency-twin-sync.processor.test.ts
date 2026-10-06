import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  AGENCY_TWIN_POLL_EVERY_MS,
  AGENCY_TWIN_POLL_JOB,
  AGENCY_TWIN_POLL_SCHEDULER_ID,
  AGENCY_TWIN_SWEEP_EVERY_MS,
  AGENCY_TWIN_SWEEP_JOB,
  AGENCY_TWIN_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { AgencyTwinSyncProcessor } from "./agency-twin-sync.processor";

const SUMMARY = {
  armed: true,
  jobs: 0,
  written: 0,
  unchanged: 0,
  blocked: 0,
  failed: 0,
  disarmed: 0,
};

function setup(upsert = vi.fn(async () => undefined)) {
  const twins = { sweep: vi.fn(async () => SUMMARY), pollRecentEvents: vi.fn(async () => SUMMARY) };
  const queue = { upsertJobScheduler: upsert };
  return { p: new AgencyTwinSyncProcessor(twins as never, queue as never), twins, upsert };
}

describe("AgencyTwinSyncProcessor — the two clocks (ADR-0050 §5)", () => {
  it("registers BOTH schedulers at boot, whatever the flag (disarmed, the sweep is the kill switch)", async () => {
    const { p, upsert } = setup();
    await p.onApplicationBootstrap();
    expect(upsert).toHaveBeenCalledWith(
      AGENCY_TWIN_POLL_SCHEDULER_ID,
      { every: AGENCY_TWIN_POLL_EVERY_MS },
      { name: AGENCY_TWIN_POLL_JOB },
    );
    expect(upsert).toHaveBeenCalledWith(
      AGENCY_TWIN_SWEEP_SCHEDULER_ID,
      { every: AGENCY_TWIN_SWEEP_EVERY_MS },
      { name: AGENCY_TWIN_SWEEP_JOB },
    );
  });

  it("a registration failure never fails boot", async () => {
    const { p } = setup(vi.fn(async () => Promise.reject(new Error("redis down"))));
    await expect(p.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("dispatches by job name: sweep → sweep, poll → the event poll", async () => {
    const { p, twins } = setup();
    await p.process({ name: AGENCY_TWIN_SWEEP_JOB } as never);
    expect(twins.sweep).toHaveBeenCalledTimes(1);
    await p.process({ name: AGENCY_TWIN_POLL_JOB } as never);
    expect(twins.pollRecentEvents).toHaveBeenCalledTimes(1);
  });
});

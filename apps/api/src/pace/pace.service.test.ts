import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { PaceState } from "@badabhai/db";
import type { JobSpec } from "@badabhai/reach-engine";
import { PaceService } from "./pace.service";

const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TRACE = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };
const NOW = new Date("2026-06-19T12:00:00.000Z");

function cfg(overrides: Partial<Record<string, unknown>> = {}): ServerConfig {
  return {
    PACE_ENABLED: true,
    PACE_THIN_SUPPLY_MIN: 3,
    PACE_AREA_STEP_KM: 15,
    PACE_MAX_AREA_KM: 75,
    PACE_WAVE_INTERVAL_HOURS: 6,
    PACE_OPS_ALERT_AFTER_HOURS: 24,
    PACE_ADJACENCY_ENABLED: false,
    ...overrides,
  } as unknown as ServerConfig;
}

function state(overrides: Partial<PaceState> = {}): PaceState {
  return {
    id: "id-1",
    jobId: JOB,
    stage: "base",
    wave: 0,
    currentAreaKm: 30,
    lastSupplyCount: 0,
    opsAlertRaised: false,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PaceState;
}

const JOB_SPEC: JobSpec = { jobId: JOB, roleIds: ["vmc_operator"], city: "pune", maxTravelKm: 30 };

/** PaceService with the reach-engine supply computation overridden so escalation is
 * driven deterministically (the engine itself is proven in the reach suite). */
class TestPaceService extends PaceService {
  public supply = 0;
  protected override async countAboveFloorSupply(): Promise<number> {
    return this.supply;
  }
}

function makeDeps(config: ServerConfig, current?: PaceState | undefined) {
  const repo = {
    findByJobId: vi.fn(async () => current),
    listOpsAlerted: vi.fn(async () => [] as PaceState[]),
    create: vi.fn(async () => state()),
    updateSupply: vi.fn(async () => {}),
    applyWiden: vi.fn(async () => {}),
    raiseOpsAlert: vi.fn(async () => {}),
  };
  const events = {
    // Typed param so `emit.mock.calls[0]` carries the asserted fields under strict TS
    // (the deps object is cast to the real EventsService, so this does not constrain
    // the service's actual emit() call — it only types the test's mock.calls access).
    emit: vi.fn(
      async (_p: { event_name: string; payload: Record<string, unknown>; idempotencyKey?: string }) => {},
    ),
    emitMany: vi.fn(async () => {}),
  };
  const reachRepo = { listSignalRows: vi.fn(async () => []) };
  const jobs = { getJobSpec: vi.fn(async () => JOB_SPEC), listOpenJobSpecs: vi.fn(async () => []) };
  const queue = { add: vi.fn(async () => {}) };
  const svc = new TestPaceService(
    config,
    repo as never,
    events as never,
    reachRepo as never,
    jobs as never,
    queue as never,
  );
  return { svc, repo, events, reachRepo, jobs, queue };
}

describe("PaceService.runWave — apply + emit + schedule (ADR-0021)", () => {
  let d: ReturnType<typeof makeDeps>;

  it("thin supply → widens AREA one step, emits a faceless pace.wave_widened, schedules next wave", async () => {
    d = makeDeps(cfg(), state({ stage: "base", currentAreaKm: 30 }));
    d.svc.supply = 0;
    await d.svc.runWave(JOB, TRACE, NOW);

    expect(d.repo.applyWiden).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({ stage: "area", areaKm: 45, supplyCount: 0 }),
    );
    const [emitArg] = d.events.emit.mock.calls[0]!;
    expect(emitArg.event_name).toBe("pace.wave_widened");
    expect(emitArg.payload).toEqual({ job_id: JOB, stage: "area", supply_count: 0, elapsed_hours: 0 });
    expect(emitArg.idempotencyKey).toBe(`pace.wave_widened:${JOB}:1`);
    expect(d.queue.add).toHaveBeenCalledTimes(1); // next wave scheduled (delayed)
  });

  it("PII-FREE: a widen event payload carries ONLY opaque job_id + stage + counts + elapsed", async () => {
    d = makeDeps(cfg(), state());
    d.svc.supply = 0;
    await d.svc.runWave(JOB, TRACE, NOW);
    const [emitArg] = d.events.emit.mock.calls[0]!;
    expect(Object.keys(emitArg.payload).sort()).toEqual(
      ["elapsed_hours", "job_id", "stage", "supply_count"].sort(),
    );
  });

  it("healthy supply → no widen, no event, no further wave (records supply only)", async () => {
    d = makeDeps(cfg(), state());
    d.svc.supply = 5; // >= thinSupplyMin (3)
    await d.svc.runWave(JOB, TRACE, NOW);

    expect(d.repo.updateSupply).toHaveBeenCalledWith(JOB, 5, NOW);
    expect(d.repo.applyWiden).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
    expect(d.queue.add).not.toHaveBeenCalled(); // terminal — supply is enough
  });

  it("area maxed + adjacency off + past the window → raises a faceless OPS ALERT, no further wave", async () => {
    const startedAt = new Date(NOW.getTime() - 25 * 3_600_000); // 25h ago (> 24h window)
    d = makeDeps(cfg(), state({ stage: "area", currentAreaKm: 75, startedAt }));
    d.svc.supply = 0;
    await d.svc.runWave(JOB, TRACE, NOW);

    expect(d.repo.raiseOpsAlert).toHaveBeenCalledWith(JOB, 0, NOW);
    const [emitArg] = d.events.emit.mock.calls[0]!;
    expect(emitArg.event_name).toBe("pace.ops_alert_raised");
    expect(Object.keys(emitArg.payload).sort()).toEqual(
      ["elapsed_hours", "job_id", "supply_count"].sort(),
    );
    expect(emitArg.idempotencyKey).toBe(`pace.ops_alert_raised:${JOB}`);
    expect(d.queue.add).not.toHaveBeenCalled(); // terminal
  });

  it("thin but pre-window (area maxed) → schedules another wave, emits nothing yet", async () => {
    const startedAt = new Date(NOW.getTime() - 6 * 3_600_000); // 6h ago (< 24h)
    d = makeDeps(cfg(), state({ stage: "area", currentAreaKm: 75, startedAt }));
    d.svc.supply = 0;
    await d.svc.runWave(JOB, TRACE, NOW);

    expect(d.events.emit).not.toHaveBeenCalled();
    expect(d.repo.raiseOpsAlert).not.toHaveBeenCalled();
    expect(d.queue.add).toHaveBeenCalledTimes(1); // keep checking until the window
  });

  it("a run already at ops_alert is terminal — no re-evaluation", async () => {
    d = makeDeps(cfg(), state({ stage: "ops_alert", opsAlertRaised: true }));
    d.svc.supply = 0;
    await d.svc.runWave(JOB, TRACE, NOW);
    expect(d.events.emit).not.toHaveBeenCalled();
    expect(d.queue.add).not.toHaveBeenCalled();
  });

  it("disabled (PACE_ENABLED=false) → runWave is inert (no emit, no schedule, no writes)", async () => {
    d = makeDeps(cfg({ PACE_ENABLED: false }), state());
    d.svc.supply = 0;
    await d.svc.runWave(JOB, TRACE, NOW);
    expect(d.repo.applyWiden).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
    expect(d.queue.add).not.toHaveBeenCalled();
  });
});

describe("PaceService.startForJob (ADR-0021)", () => {
  it("disabled → returns null and does not create or schedule", async () => {
    const d = makeDeps(cfg({ PACE_ENABLED: false }), undefined);
    const res = await d.svc.startForJob(JOB, TRACE, NOW);
    expect(res).toBeNull();
    expect(d.repo.create).not.toHaveBeenCalled();
    expect(d.queue.add).not.toHaveBeenCalled();
  });

  it("enabled + no existing run → creates state at base + schedules wave 1", async () => {
    const d = makeDeps(cfg(), undefined);
    const res = await d.svc.startForJob(JOB, TRACE, NOW);
    expect(res).not.toBeNull();
    expect(d.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB, currentAreaKm: 30, startedAt: NOW }),
    );
    expect(d.queue.add).toHaveBeenCalledTimes(1);
  });

  it("idempotent — an existing run is returned without re-creating or re-scheduling", async () => {
    const existing = state({ stage: "area", wave: 2 });
    const d = makeDeps(cfg(), existing);
    const res = await d.svc.startForJob(JOB, TRACE, NOW);
    expect(res).toBe(existing);
    expect(d.repo.create).not.toHaveBeenCalled();
    expect(d.queue.add).not.toHaveBeenCalled();
  });
});

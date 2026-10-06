import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AGENCY_TWIN_ORG_LABEL, AGENCY_TWIN_SYSTEM_ACTOR_ID } from "@badabhai/config";
import { createEvent } from "@badabhai/event-schema";
import type { AgencyTwinContext, AgencyTwinEmitter, AgencyTwinWrite } from "@badabhai/db";
import {
  AGENCY_TWIN_DISARM_BATCH,
  AGENCY_TWIN_EVENT_LOOKBACK_MS,
  AGENCY_TWIN_SWEEP_PAGE,
  AgencyTwinService,
} from "./agency-twin.service";
import type { AgencyTwinRepository } from "./agency-twin.repository";

/**
 * ADR-0050 — the api half of the agency twin sync: the kill switch, the two triggers, the
 * per-job isolation and the event. The plan/diff/write itself is the shared core in
 * `@badabhai/db` (its own unit tests + the DB-gated `agency-twin-sync.db.test.ts`).
 */

const TX = { executor: "agency-twin-test-tx" };
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const TWIN = "33333333-3333-4333-8333-333333333333";

const WRITE: AgencyTwinWrite = {
  kind: "written",
  sourceJobId: JOB_A,
  jobPostingId: TWIN,
  operation: "created",
  status: "draft",
  changedFields: ["role_title", "status"],
  refusedReason: null,
};

function setup(opts: { armed: boolean; matchV1?: boolean; ids?: string[][]; failOn?: string }) {
  const pages = [...(opts.ids ?? [[JOB_A, JOB_B]])];
  const repo = {
    sync: vi.fn(async (jobId: string, _ctx: AgencyTwinContext, emit: AgencyTwinEmitter) => {
      if (jobId === opts.failOn) throw new Error("deadlock detected");
      await emit(TX as never, { ...WRITE, sourceJobId: jobId });
      return { ...WRITE, sourceJobId: jobId };
    }),
    disarm: vi.fn(async (_limit: number, emit: (tx: never, m: never) => Promise<void>) => {
      await emit(TX as never, { jobPostingId: TWIN, sourceJobId: JOB_A } as never);
      return [{ jobPostingId: TWIN, sourceJobId: JOB_A }];
    }),
    listAgencyJobIds: vi.fn(async () => pages.shift() ?? []),
    recentAgencyJobIds: vi.fn(async () => [JOB_A]),
  };
  // The REAL event builder validates every emitted payload against the registry.
  const emitted: unknown[] = [];
  const events = {
    emit: vi.fn(async (p: Record<string, unknown>) => {
      emitted.push(
        createEvent({
          event_name: p.event_name as "job_posting.twin_synced",
          actor: p.actor as never,
          subject: p.subject as never,
          payload: p.payload as never,
          source: "api",
          metadata: { environment: "test", service: "api", request_id: null },
        }),
      );
      return p;
    }),
  };
  const matchConfig = { get: vi.fn(async () => ({ relatedSkillsDefault: "off" })) };
  const svc = new AgencyTwinService(
    repo as unknown as AgencyTwinRepository,
    events as never,
    matchConfig as never,
    { AGENCY_TWIN_SYNC_ENABLED: opts.armed, MATCH_V1_ENABLED: opts.matchV1 ?? false } as never,
  );
  return { svc, repo, events, emitted };
}

describe("AgencyTwinService — boot (ADR-0050 Q3)", () => {
  it("accepts the shipped system actor and neutral label", () => {
    expect(() => setup({ armed: false }).svc.onModuleInit()).not.toThrow();
    expect(AGENCY_TWIN_SYSTEM_ACTOR_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(AGENCY_TWIN_ORG_LABEL.length).toBeGreaterThan(0);
  });
});

describe("AgencyTwinService — DISARMED is the kill switch (ADR-0050 §7)", () => {
  it("the sweep runs ONLY the bounded disarm, and emits a kill_switch refusal per twin on its tx", async () => {
    const { svc, repo, events, emitted } = setup({ armed: false });
    const summary = await svc.sweep();
    expect(repo.disarm).toHaveBeenCalledWith(AGENCY_TWIN_DISARM_BATCH, expect.any(Function));
    expect(repo.sync).not.toHaveBeenCalled();
    expect(repo.listAgencyJobIds).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ armed: false, disarmed: 1, written: 0 });
    const call = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.tx).toBe(TX);
    expect(call.actor).toEqual({ actor_type: "system", actor_id: null });
    expect(call.payload).toEqual({
      job_posting_id: TWIN,
      source_job_id: JOB_A,
      operation: "refused",
      status: "paused",
      changed_fields: ["status"],
      refused_reason: "kill_switch",
    });
    expect(emitted).toHaveLength(1); // validated by the registry
  });

  it("the event poll and a direct sync do nothing at all", async () => {
    const { svc, repo } = setup({ armed: false });
    expect(await svc.pollRecentEvents()).toMatchObject({ armed: false, jobs: 0 });
    expect(await svc.syncJob(JOB_A)).toBeNull();
    expect(repo.recentAgencyJobIds).not.toHaveBeenCalled();
    expect(repo.sync).not.toHaveBeenCalled();
    expect(repo.disarm).not.toHaveBeenCalled();
  });
});

describe("AgencyTwinService — ARMED", () => {
  it("syncs with the deploy's V1 state, the config's breadth and the Q3 constants", async () => {
    const { svc, repo } = setup({ armed: true, matchV1: true });
    await svc.syncJob(JOB_A);
    expect(repo.sync.mock.calls[0]![1]).toEqual({
      matchV1Enabled: true,
      relatedSkillsDefault: "off",
      systemActorId: AGENCY_TWIN_SYSTEM_ACTOR_ID,
      orgLabel: AGENCY_TWIN_ORG_LABEL,
    });
  });

  it("emits one validated job_posting.twin_synced per write, on the write's transaction", async () => {
    const { svc, events, emitted } = setup({ armed: true });
    await svc.syncJob(JOB_A);
    const call = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event_name).toBe("job_posting.twin_synced");
    expect(call.tx).toBe(TX);
    expect(call.subject).toEqual({ subject_type: "job_posting", subject_id: TWIN });
    expect(call.payload).toEqual({
      job_posting_id: TWIN,
      source_job_id: JOB_A,
      operation: "created",
      status: "draft",
      changed_fields: ["role_title", "status"],
      refused_reason: null,
    });
    expect(emitted).toHaveLength(1);
  });

  it("the event poll reads a window of the spine and syncs exactly those agency jobs", async () => {
    const { svc, repo } = setup({ armed: true });
    const now = new Date("2026-10-06T12:00:00.000Z");
    const s = await svc.pollRecentEvents(now);
    expect(repo.recentAgencyJobIds).toHaveBeenCalledWith(
      new Date(now.getTime() - AGENCY_TWIN_EVENT_LOOKBACK_MS),
      expect.any(Number),
    );
    expect(repo.sync.mock.calls.map((c) => c[0])).toEqual([JOB_A]);
    expect(s).toMatchObject({ armed: true, jobs: 1, written: 1 });
  });

  it("the sweep walks every page by keyset and stops on a short page", async () => {
    const full = Array.from(
      { length: AGENCY_TWIN_SWEEP_PAGE },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const { svc, repo } = setup({ armed: true, ids: [full, [JOB_A]] });
    const s = await svc.sweep();
    expect(repo.listAgencyJobIds).toHaveBeenNthCalledWith(1, null, AGENCY_TWIN_SWEEP_PAGE);
    expect(repo.listAgencyJobIds).toHaveBeenNthCalledWith(2, full.at(-1), AGENCY_TWIN_SWEEP_PAGE);
    expect(repo.listAgencyJobIds).toHaveBeenCalledTimes(2);
    expect(s.jobs).toBe(AGENCY_TWIN_SWEEP_PAGE + 1);
    expect(repo.disarm).not.toHaveBeenCalled();
  });

  it("one job's failure never stops the others — it is counted and left to the next sweep", async () => {
    const { svc, repo } = setup({ armed: true, failOn: JOB_A });
    const s = await svc.sweep();
    expect(repo.sync.mock.calls.map((c) => c[0])).toEqual([JOB_A, JOB_B]);
    expect(s).toMatchObject({ jobs: 2, failed: 1, written: 1 });
  });
});

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { WorkerActivityRepository } from "../worker-activity/worker-activity.repository";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";
import type { CampusApplicationsRepository } from "./campus-applications.repository";
import { CampusApplicationsService } from "./campus-applications.service";
import type { InstituteLinkService } from "./institute-link.service";

/**
 * #2753 item 4 — a Campus application is activity: once it has COMMITTED, the student's IST day is
 * recorded (fire-and-forget, switch-gated). A refusal, a rollback and a replayed ref record nothing.
 * The gate, the transaction and the events themselves are proven in `campus-jobs.db.test.ts`.
 */
const WORKER = "11111111-1111-4111-8111-111111111111";
const POSTING = "22222222-2222-4222-8222-222222222222";
const STUDENT_REF = "33333333-3333-4333-8333-333333333333";
const CTX = { correlationId: "c", requestId: "r" } as unknown as RequestContext;
const BODY = { external_ref: "campus-app-1", posting_id: POSTING, student_ref: STUDENT_REF };
const NOW = new Date("2026-11-16T06:00:00.000Z");

/** Drain the fire-and-forget write. */
const flush = () => new Promise((r) => setImmediate(r));

function setup(opts: { on: boolean; known?: boolean; commitFails?: boolean; closed?: boolean }) {
  const row = {
    id: "44444444-4444-4444-8444-444444444444",
    externalRef: BODY.external_ref,
    jobPostingId: POSTING,
    workerId: WORKER,
    applicationId: "55555555-5555-4555-8555-555555555555",
    withdrawnAt: null,
    updatedAt: NOW,
  };
  const view = { ...row, studentRef: STUDENT_REF, stage: null, changedAt: NOW };
  const repo = {
    findByRef: vi.fn(async () => (opts.known ? view : undefined)),
    postingGate: vi.fn(async () => ({
      reachesRvm: true,
      status: opts.closed ? "closed" : "open",
      hidden: false,
      approved: true,
    })),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const out = await work({});
      if (opts.commitFails) throw new Error("serialization failure");
      return out;
    }),
    lockRef: vi.fn(async () => undefined),
    findForWorkerPosting: vi.fn(async () => undefined),
    findDecision: vi.fn(async () => undefined),
    insertApplication: vi.fn(async () => row.applicationId),
    insertCampusApplication: vi.fn(async () => row),
  };
  const links = { linkStudent: vi.fn(async () => ({ workerId: WORKER })) };
  const events = { emit: vi.fn(async () => undefined) };
  const activityRepo = { touch: vi.fn(async () => undefined), lastActiveDays: vi.fn() };
  const activity = new WorkerActivityService(activityRepo as unknown as WorkerActivityRepository, {
    WORKER_ACTIVITY_ENABLED: opts.on,
    NOT_RECENTLY_ACTIVE_DAYS: 90,
  });
  const svc = new CampusApplicationsService(
    repo as unknown as CampusApplicationsRepository,
    links as unknown as InstituteLinkService,
    events as unknown as EventsService,
    activity,
  );
  return { svc, activityRepo, repo };
}

describe("CampusApplicationsService.apply — the student's last-active day (#2753)", () => {
  it("switch on: a new application records his day once, after the commit", async () => {
    const { svc, activityRepo } = setup({ on: true });
    const out = await svc.apply(BODY, CTX);
    expect(out.created).toBe(true);
    await flush();
    expect(activityRepo.touch).toHaveBeenCalledTimes(1);
    expect(activityRepo.touch).toHaveBeenCalledWith(
      WORKER,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("switch off: nothing is recorded", async () => {
    const { svc, activityRepo } = setup({ on: false });
    await svc.apply(BODY, CTX);
    await flush();
    expect(activityRepo.touch).not.toHaveBeenCalled();
  });

  it("a replayed ref (the same application again) records nothing", async () => {
    const { svc, activityRepo } = setup({ on: true, known: true });
    const out = await svc.apply(BODY, CTX);
    expect(out.created).toBe(false);
    await flush();
    expect(activityRepo.touch).not.toHaveBeenCalled();
  });

  it("a refusal records nothing", async () => {
    const { svc, activityRepo } = setup({ on: true, closed: true });
    await expect(svc.apply(BODY, CTX)).rejects.toBeDefined();
    await flush();
    expect(activityRepo.touch).not.toHaveBeenCalled();
  });

  it("a transaction that fails to commit records nothing", async () => {
    const { svc, activityRepo } = setup({ on: true, commitFails: true });
    await expect(svc.apply(BODY, CTX)).rejects.toThrow("serialization failure");
    await flush();
    expect(activityRepo.touch).not.toHaveBeenCalled();
  });

  it("a failed write never fails Campus's answer", async () => {
    const { svc, activityRepo } = setup({ on: true });
    activityRepo.touch.mockRejectedValue(new Error("down"));
    await expect(svc.apply(BODY, CTX)).resolves.toMatchObject({ created: true });
    await flush();
  });
});

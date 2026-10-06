import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { RankSnapshot } from "../match/match-apply.service";
import { ApplicationsService } from "./applications.service";
import type { ApplicationsRepository } from "./applications.repository";

/**
 * #1823 (ADR-0049) — APPLY AND SKIP WITH THE INTERIM UNION ARMED (MATCH_V1 off).
 *
 * The route is unchanged and still takes a bare uuid; the server decides which table it
 * names. An OPEN `jobs` row first (today's path, byte for byte), then an OPEN `job_postings`
 * row, else the identical neutral 404. A posting decision goes through the SAME writer V1
 * uses — `applications.job_posting_id`, the E16 freeze, subject `job_posting` — with the one
 * difference that its snapshot is taken only when a reach row exists (ADR-0049 S3).
 *
 * The sibling `applications.service.test.ts` pins the flag-OFF contract; this file is the
 * flag-ON one.
 */

const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const WORKER = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const POSTING = "33333333-3333-4333-8333-333333333333";
const BOTH = "44444444-4444-4444-8444-444444444444";
const APP_ID = "55555555-5555-4555-8555-555555555555";

const SNAPSHOT: RankSnapshot = {
  matchTier: 1,
  skillMonths: 48,
  industryMonths: 60,
  lastWorkedAt: null,
  engineVersion: "v1.0",
};

function setup(
  opts: {
    openJobs?: string[];
    openPostings?: string[];
    snapshot?: RankSnapshot | null;
    existingPostingDecision?: { id: string; action: string };
    matchV1?: boolean;
  } = {},
) {
  const openJobs = new Set(opts.openJobs ?? [JOB, BOTH]);
  const openPostings = new Set(opts.openPostings ?? [POSTING, BOTH]);
  const repo = {
    findJobById: vi.fn(async (id: string) =>
      openJobs.has(id) ? { id, status: "open" } : undefined,
    ),
    findOpenPostingRef: vi.fn(async (id: string) => (openPostings.has(id) ? { id } : undefined)),
    findDecision: vi.fn(async () => undefined),
    upsertDecision: vi.fn(async (input: Record<string, unknown>) => ({
      id: "legacy-app",
      ...input,
      inserted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    incrementApplicantsReceived: vi.fn(async () => 1),
    findOpenJobs: vi.fn(async () => []),
    findOpenPostingsForFeed: vi.fn(async () => []),
  };
  const events = {
    emit: vi.fn(async (p: Record<string, unknown>) => p),
    emitMany: vi.fn(async (l: unknown[]) => l),
  };
  const matchFeed = { getFeed: vi.fn(async () => ({ jobs: [], next: null })) };
  const matchApply = {
    buildSnapshot: vi.fn(async () => SNAPSHOT),
    trySnapshot: vi.fn(async () => ("snapshot" in opts ? opts.snapshot : null)),
    findDecision: vi.fn(async () => opts.existingPostingDecision),
    upsertDecision: vi.fn(async (_input: Record<string, unknown>) => ({
      applicationId: APP_ID,
      inserted: true,
      flippedToApplied: false,
      snapshot: null,
    })),
  };
  const workerSkills = { listWantedSkillIds: vi.fn(async () => []) };
  const svc = new ApplicationsService(
    repo as unknown as ApplicationsRepository,
    events as unknown as EventsService,
    matchFeed as never,
    matchApply as never,
    { MATCH_V1_ENABLED: opts.matchV1 ?? false, FEED_POSTINGS_UNION_ENABLED: true } as never,
    workerSkills as never,
  );
  return { svc, repo, events, matchApply };
}

const apply = (svc: ApplicationsService, id: string) =>
  svc.apply(WORKER, id, { rank: 2, source_surface: "feed" }, CTX);
const skip = (svc: ApplicationsService, id: string) =>
  svc.skip(WORKER, id, { reason: "too_far" }, CTX);

describe("union on — a `jobs` id runs the legacy path exactly", () => {
  it("apply: job_id upsert, counter bump, subject job, key on the jobs id", async () => {
    const { svc, repo, events, matchApply } = setup();
    const out = await apply(svc, JOB);

    expect(repo.upsertDecision.mock.calls[0]![0]).toMatchObject({ workerId: WORKER, jobId: JOB });
    expect(repo.incrementApplicantsReceived).toHaveBeenCalledExactlyOnceWith(JOB);
    const ev = events.emit.mock.calls[0]![0];
    expect(ev.subject).toEqual({ subject_type: "job", subject_id: JOB });
    expect(ev.idempotencyKey).toBe(`application.submitted:${WORKER}:${JOB}`);
    expect(out).toEqual({ ok: true, application_id: "legacy-app", action: "applied" });
    // A hit on `jobs` never even asks the posting table.
    expect(repo.findOpenPostingRef).not.toHaveBeenCalled();
    for (const fn of Object.values(matchApply)) expect(fn).not.toHaveBeenCalled();
  });

  it("skip: job_id upsert, subject job, no posting read", async () => {
    const { svc, repo, events, matchApply } = setup();
    await skip(svc, JOB);
    expect(repo.upsertDecision.mock.calls[0]![0]).toMatchObject({ jobId: JOB, action: "skipped" });
    expect(events.emit.mock.calls[0]![0].subject).toEqual({ subject_type: "job", subject_id: JOB });
    expect(repo.findOpenPostingRef).not.toHaveBeenCalled();
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
  });

  it("an id present in BOTH tables resolves to the job (the GET /jobs/:id precedence)", async () => {
    const { svc, repo, matchApply } = setup();
    await apply(svc, BOTH);
    expect(repo.upsertDecision.mock.calls[0]![0]).toMatchObject({ jobId: BOTH });
    expect(repo.findOpenPostingRef).not.toHaveBeenCalled();
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
  });
});

describe("union on — an OPEN posting id goes through the shared posting writer", () => {
  it("apply: trySnapshot, then the V1 upsert on job_posting_id — no counter, no V1 gate", async () => {
    const { svc, repo, matchApply } = setup({ snapshot: null });
    const out = await apply(svc, POSTING);

    expect(matchApply.trySnapshot).toHaveBeenCalledExactlyOnceWith(WORKER, POSTING);
    // The union's gate is "open posting" (already passed), NOT V1's reach-row 404.
    expect(matchApply.buildSnapshot).not.toHaveBeenCalled();
    expect(matchApply.upsertDecision).toHaveBeenCalledExactlyOnceWith({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: 2,
      snapshot: null,
      previousAction: null,
    });
    // `job_postings` has no applicants counter, and bumping `jobs` with a posting id would
    // touch a row in another id space.
    expect(repo.incrementApplicantsReceived).not.toHaveBeenCalled();
    expect(repo.upsertDecision).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, application_id: APP_ID, action: "applied" });
  });

  it("apply emits application.submitted v1 on subject job_posting, keyed like V1", async () => {
    const { svc, events } = setup();
    await apply(svc, POSTING);

    const ev = events.emit.mock.calls[0]![0];
    expect(ev.event_name).toBe("application.submitted");
    expect(ev.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING });
    // Byte-identical to V1's key, so a union apply and a later V1 apply are one event.
    expect(ev.idempotencyKey).toBe(`application.submitted:${WORKER}:${POSTING}`);
    expect(Object.keys(ev.payload as object).sort()).toEqual([
      "job_id",
      "rank",
      "source_surface",
      "worker_id",
    ]);
    expect(ev.payload).toEqual({
      worker_id: WORKER,
      job_id: POSTING,
      rank: 2,
      source_surface: "feed",
    });
  });

  it("passes a NULL snapshot through when there is no reach row, and the snapshot when there is", async () => {
    const without = setup({ snapshot: null });
    await apply(without.svc, POSTING);
    expect(without.matchApply.upsertDecision.mock.calls[0]![0]).toMatchObject({ snapshot: null });

    const withReach = setup({ snapshot: SNAPSHOT });
    await apply(withReach.svc, POSTING);
    expect(withReach.matchApply.upsertDecision.mock.calls[0]![0]).toMatchObject({
      snapshot: SNAPSHOT,
    });
  });

  it("carries the previous action through, so the SQL can tell a flip from a double-tap", async () => {
    const { svc, matchApply } = setup({
      existingPostingDecision: { id: APP_ID, action: "skipped" },
    });
    await apply(svc, POSTING);
    expect(matchApply.upsertDecision.mock.calls[0]![0]).toMatchObject({
      previousAction: "skipped",
    });
  });

  it("skip: a NULL snapshot, subject job_posting, keyed on the posting — and no snapshot read", async () => {
    const { svc, events, matchApply } = setup();
    const out = await skip(svc, POSTING);

    expect(matchApply.trySnapshot).not.toHaveBeenCalled();
    expect(matchApply.upsertDecision).toHaveBeenCalledExactlyOnceWith({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "skipped",
      reason: "too_far",
      sourceSurface: "feed",
      rank: null,
      snapshot: null,
      previousAction: null,
    });
    const ev = events.emit.mock.calls[0]![0];
    expect(ev.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING });
    expect(ev.idempotencyKey).toBe(`application.skipped:${WORKER}:${POSTING}`);
    expect(ev.payload).toEqual({ worker_id: WORKER, job_id: POSTING, reason: "too_far" });
    expect(out).toEqual({ ok: true, application_id: APP_ID, action: "skipped" });
  });

  it("TD73 — skip on an APPLIED posting returns applied, with no write and no event", async () => {
    const { svc, events, matchApply } = setup({
      existingPostingDecision: { id: APP_ID, action: "applied" },
    });
    const out = await skip(svc, POSTING);
    expect(out).toEqual({ ok: true, application_id: APP_ID, action: "applied" });
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("union on — an id that is not an OPEN row is the identical neutral 404", () => {
  // ONE case, on purpose. To this service, unknown, closed, paused, suspended and draft are
  // the same input: a miss from `findOpenPostingRef`, whose `status = 'open'` filter is pinned
  // in the repository test. Per-status labels over one stub would claim coverage a stub cannot
  // give; the per-status proof runs against real SQL in `feed-union.db.test.ts` (draft, paused
  // and closed on apply; suspended on apply AND skip, inside the cascade case).
  it("a posting id with no OPEN row 404s on apply AND skip — today's body — with zero writes and zero events", async () => {
    const { svc, repo, events, matchApply } = setup({ openPostings: [] });
    for (const decide of [() => apply(svc, POSTING), () => skip(svc, POSTING)]) {
      const err = await decide().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      // Byte-identical to the 404 this route has always returned — no oracle by body either.
      expect((err as NotFoundException).getResponse()).toEqual(
        new NotFoundException("Job not found").getResponse(),
      );
    }
    expect(repo.findOpenPostingRef).toHaveBeenCalledWith(POSTING); // the gate really ran
    expect(repo.upsertDecision).not.toHaveBeenCalled();
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
    expect(matchApply.trySnapshot).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("MATCH_V1_ENABLED wins — the union flag is inert under V1", () => {
  it("apply and skip route to the V1 reach gate, never the union resolution", async () => {
    const { svc, repo, matchApply } = setup({ matchV1: true });
    await apply(svc, POSTING);
    await skip(svc, POSTING);

    expect(matchApply.buildSnapshot).toHaveBeenCalledTimes(2);
    expect(matchApply.trySnapshot).not.toHaveBeenCalled();
    expect(repo.findJobById).not.toHaveBeenCalled();
    expect(repo.findOpenPostingRef).not.toHaveBeenCalled();
  });

  it("V1 apply still hands the writer buildSnapshot's snapshot, unchanged by the extraction", async () => {
    const { svc, matchApply } = setup({ matchV1: true });
    await apply(svc, POSTING);
    expect(matchApply.upsertDecision.mock.calls[0]![0]).toMatchObject({ snapshot: SNAPSHOT });
  });
});

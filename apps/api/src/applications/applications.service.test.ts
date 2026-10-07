import "reflect-metadata";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Logger, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { ApplicationsService } from "./applications.service";
import type { ApplicationsRepository } from "./applications.repository";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const WORKER_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";

const JOB_ROW = {
  id: JOB_ID,
  tradeKey: "cnc_operator" as const,
  title: "CNC Operator — Night Shift",
  city: "Pune",
  area: "Pimpri-Chinchwad",
  status: "open" as const,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  updatedAt: new Date("2026-06-01T00:00:00Z"),
};

/**
 * Test double for the (worker, job) -> row state the DB enforces. Keyed by
 * `${workerId}:${jobId}` so a repeat upsert on the same key reports `inserted:false`
 * (mirrors ON CONFLICT DO UPDATE) and a fresh key reports `inserted:true`. This lets
 * the suite exercise the counter-increment gate the way Postgres `(xmax = 0)` would.
 */
function setup(opts: { jobExists?: boolean; openJobs?: Array<Record<string, unknown>> } = {}) {
  const jobExists = opts.jobExists ?? true;
  // (workerId:jobId) -> decision row
  const decisions = new Map<string, Record<string, unknown>>();
  // Per-job applies counter, bumped only by incrementApplicantsReceived.
  const applicantsReceived = new Map<string, number>();
  const repo = {
    findJobById: vi.fn(async () => (jobExists ? JOB_ROW : undefined)),
    findOpenJobs: vi.fn(async () => opts.openJobs ?? []),
    findDecision: vi.fn(async (workerId: string, jobId: string) => {
      const row = decisions.get(`${workerId}:${jobId}`);
      return row ? { ...row } : undefined;
    }),
    upsertDecision: vi.fn(async (input: Record<string, unknown>) => {
      const key = `${String(input.workerId)}:${String(input.jobId)}`;
      const inserted = !decisions.has(key);
      decisions.set(key, { ...input });
      return {
        id: "app-1",
        ...input,
        inserted,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }),
    incrementApplicantsReceived: vi.fn(async (jobId: string) => {
      const next = (applicantsReceived.get(jobId) ?? 0) + 1;
      applicantsReceived.set(jobId, next);
      return next;
    }),
    findApplicantsByJob: vi.fn(async () => []),
    // #1823 — the ops applicants read resolves the id space first: JOB_ID is a `jobs` row.
    legacyJobExists: vi.fn(async (id: string) => id === JOB_ID),
    findApplicantsByPosting: vi.fn(async () => []),
    findApplicationsByWorker: vi.fn(async () => []),
    // #1823 — the interim union's reads. FEED_POSTINGS_UNION_ENABLED is absent from this
    // file's config, so neither may ever be called here (asserted below).
    findOpenPostingRef: vi.fn(async () => ({ id: JOB_ID })),
    findOpenPostingsForFeed: vi.fn(async () => []),
  };
  const events = {
    emit: vi.fn(async (params: Record<string, unknown>) => params),
    emitMany: vi.fn(async (list: Array<Record<string, unknown>>) => list),
  };
  // ADR-0036: the V1 collaborators. Every case in this file exercises the LEGACY path
  // (MATCH_V1_ENABLED false), so these must never be called — asserted below, so a
  // regression that leaks the V1 branch into the flag-off path fails loudly rather than
  // quietly changing what `/feed` serves.
  const matchFeed = { getFeed: vi.fn(async () => ({ jobs: [], next: null })) };
  const matchApply = {
    buildSnapshot: vi.fn(),
    trySnapshot: vi.fn(),
    findDecision: vi.fn(),
    upsertDecision: vi.fn(),
  };
  const workerSkills = { listWantedSkillIds: vi.fn(async () => []) };
  const svc = new ApplicationsService(
    repo as unknown as ApplicationsRepository,
    events as unknown as EventsService,
    matchFeed as never,
    matchApply as never,
    { MATCH_V1_ENABLED: false } as never,
    workerSkills as never,
  );
  // `countFor` reads the simulated denormalized jobs.applicants_received rollup.
  const countFor = (jobId: string) => applicantsReceived.get(jobId) ?? 0;
  return { svc, repo, events, countFor, matchFeed, matchApply, workerSkills };
}

describe("ApplicationsService — apply", () => {
  it("upserts action='applied' (reason null) and emits a PII-free application.submitted", async () => {
    const { svc, repo, events } = setup();
    const out = await svc.apply(WORKER_ID, JOB_ID, { rank: 3, source_surface: "feed" }, CTX);

    // Upsert uses the SESSION worker id + the path job id, action applied, no reason.
    const upsertArg = repo.upsertDecision.mock.calls[0]![0];
    expect(upsertArg).toMatchObject({
      workerId: WORKER_ID,
      jobId: JOB_ID,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: 3,
    });

    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("application.submitted");
    expect(call.actor).toEqual({ actor_type: "worker", actor_id: WORKER_ID });
    expect(call.subject).toEqual({ subject_type: "job", subject_id: JOB_ID });
    expect(call.payload).toEqual({
      worker_id: WORKER_ID,
      job_id: JOB_ID,
      rank: 3,
      source_surface: "feed",
    });
    // Idempotency key per (worker, job) so a double-tap is one logical event.
    expect(call.idempotencyKey).toBe(`application.submitted:${WORKER_ID}:${JOB_ID}`);

    expect(out).toEqual({ ok: true, application_id: "app-1", action: "applied" });
  });

  it("404s on an unknown job and emits NOTHING (no oracle, no event)", async () => {
    const { svc, repo, events } = setup({ jobExists: false });
    await expect(
      svc.apply(WORKER_ID, JOB_ID, { rank: null, source_surface: "feed" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.upsertDecision).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("is idempotent: a repeated apply on the same (worker, job) is one upsert (no duplicate row)", async () => {
    const { svc, repo } = setup();
    await svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX);
    await svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX);
    // Each call upserts the SAME natural key — the DB unique index collapses to one
    // row; the repo never inserts a second row (it is an ON CONFLICT DO UPDATE).
    expect(repo.upsertDecision).toHaveBeenCalledTimes(2);
    for (const c of repo.upsertDecision.mock.calls) {
      expect(c[0]).toMatchObject({ workerId: WORKER_ID, jobId: JOB_ID, action: "applied" });
    }
  });
});

describe("ApplicationsService — applicants_received counter (ADR-0009 rollup)", () => {
  const JOB_A = "22222222-2222-2222-2222-222222222222";
  const WORKER_A = "11111111-1111-1111-1111-111111111111";
  const WORKER_B = "33333333-3333-3333-3333-333333333333";

  it("(i) first apply increments the job counter to 1", async () => {
    const { svc, repo, countFor } = setup();
    await svc.apply(WORKER_A, JOB_A, { rank: 1, source_surface: "feed" }, CTX);
    expect(repo.incrementApplicantsReceived).toHaveBeenCalledExactlyOnceWith(JOB_A);
    expect(countFor(JOB_A)).toBe(1);
  });

  it("(ii) the SAME worker applying twice is idempotent — counter stays at 1 (no double-tap inflation)", async () => {
    const { svc, repo, countFor } = setup();
    await svc.apply(WORKER_A, JOB_A, { rank: 1, source_surface: "feed" }, CTX);
    await svc.apply(WORKER_A, JOB_A, { rank: 1, source_surface: "feed" }, CTX);
    // Second apply hits ON CONFLICT DO UPDATE (inserted:false) → no increment.
    expect(repo.incrementApplicantsReceived).toHaveBeenCalledExactlyOnceWith(JOB_A);
    expect(countFor(JOB_A)).toBe(1);
  });

  it("(iii) a skip never touches the counter — it stays at 0", async () => {
    const { svc, repo, countFor } = setup();
    await svc.skip(WORKER_A, JOB_A, { reason: "too_far" }, CTX);
    expect(repo.incrementApplicantsReceived).not.toHaveBeenCalled();
    expect(countFor(JOB_A)).toBe(0);
  });

  it("(iv) two DIFFERENT workers applying to the same job increments the counter to 2", async () => {
    const { svc, repo, countFor } = setup();
    await svc.apply(WORKER_A, JOB_A, { rank: 1, source_surface: "feed" }, CTX);
    await svc.apply(WORKER_B, JOB_A, { rank: 2, source_surface: "feed" }, CTX);
    expect(repo.incrementApplicantsReceived).toHaveBeenCalledTimes(2);
    expect(countFor(JOB_A)).toBe(2);
  });

  it("(v) a skip→apply flip on an existing row DOES increment the counter (TD38 fix)", async () => {
    const { svc, repo, countFor } = setup();
    await svc.skip(WORKER_A, JOB_A, { reason: "low_pay" }, CTX);
    // The row already exists from the skip → the apply is an UPDATE (inserted:false),
    // but findDecision detects the flip → incrementApplicantsReceived is still called.
    await svc.apply(WORKER_A, JOB_A, { rank: null, source_surface: "feed" }, CTX);
    expect(repo.incrementApplicantsReceived).toHaveBeenCalledExactlyOnceWith(JOB_A);
    expect(countFor(JOB_A)).toBe(1);
  });

  it("monotonic: an apply→skip flip never decrements the counter", async () => {
    const { svc, countFor } = setup();
    await svc.apply(WORKER_A, JOB_A, { rank: 1, source_surface: "feed" }, CTX);
    await svc.skip(WORKER_A, JOB_A, { reason: "other" }, CTX);
    expect(countFor(JOB_A)).toBe(1);
  });
});

describe("ApplicationsService — TD73, the applied->skipped downgrade guard (legacy path)", () => {
  /**
   * WA-1 was DATA DESTRUCTION, not a display bug: the decision upsert is keyed
   * (worker_id, job_id) last-write-wins, so a re-swipe of an already-applied job
   * silently flipped `applied` -> `skipped` and the application was gone.
   *
   * Server-side feed exclusion alone does NOT close this. The client's decisions read
   * caps at 500 oldest-first, so past 500 decisions the newest applies drop out of the
   * exclusion set and an applied job can be served again. The guard in `skip()` is the
   * only thing standing between that and a destroyed application.
   *
   * `skipV1` already had this test. The LEGACY path — the one that runs today, because
   * MATCH_V1_ENABLED is false in production — did not.
   */
  it("refuses to downgrade an APPLIED row, and reports it as still applied", async () => {
    const { svc, repo } = setup();
    await svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX);

    const out = await svc.skip(WORKER_ID, JOB_ID, { reason: "too_far" }, CTX);

    expect(out.action).toBe("applied");
    // The decisive assertion: no write was attempted at all. Returning "applied" while
    // still upserting `skipped` would look correct to the caller and destroy the row.
    const skipWrites = repo.upsertDecision.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === "skipped",
    );
    expect(skipWrites).toHaveLength(0);
  });

  it("emits NO application.skipped event for the refused downgrade", async () => {
    // A skipped event for an application that still exists would corrupt the spine —
    // every downstream consumer would read the worker as having withdrawn.
    const { svc, events } = setup();
    await svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX);
    events.emit.mockClear();

    await svc.skip(WORKER_ID, JOB_ID, { reason: "too_far" }, CTX);

    const skipped = events.emit.mock.calls.filter(
      (c) => (c[0] as { event_name?: string }).event_name === "application.skipped",
    );
    expect(skipped).toHaveLength(0);
  });

  it("still allows a NEW skip, and a skip->skip repeat", async () => {
    // The guard must not turn into "skips never write". Only the downgrade is refused.
    const { svc } = setup();
    expect((await svc.skip(WORKER_ID, JOB_ID, { reason: "too_far" }, CTX)).action).toBe("skipped");
    expect((await svc.skip(WORKER_ID, JOB_ID, { reason: "low_pay" }, CTX)).action).toBe("skipped");
  });
});

describe("ApplicationsService — skip", () => {
  it("upserts action='skipped' with the enum reason and emits a PII-free application.skipped", async () => {
    const { svc, repo, events } = setup();
    const out = await svc.skip(WORKER_ID, JOB_ID, { reason: "too_far" }, CTX);

    const upsertArg = repo.upsertDecision.mock.calls[0]![0];
    expect(upsertArg).toMatchObject({
      workerId: WORKER_ID,
      jobId: JOB_ID,
      action: "skipped",
      reason: "too_far",
    });

    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("application.skipped");
    expect(call.subject).toEqual({ subject_type: "job", subject_id: JOB_ID });
    expect(call.payload).toEqual({ worker_id: WORKER_ID, job_id: JOB_ID, reason: "too_far" });
    expect(call.idempotencyKey).toBe(`application.skipped:${WORKER_ID}:${JOB_ID}`);

    expect(out).toEqual({ ok: true, application_id: "app-1", action: "skipped" });
  });

  it("flips skip -> apply in place (last-write-wins): two upserts on the same key, latest action wins", async () => {
    const { svc, repo } = setup();
    await svc.skip(WORKER_ID, JOB_ID, { reason: "low_pay" }, CTX);
    await svc.apply(WORKER_ID, JOB_ID, { rank: null, source_surface: "feed" }, CTX);
    expect(repo.upsertDecision).toHaveBeenCalledTimes(2);
    expect(repo.upsertDecision.mock.calls[0]![0]).toMatchObject({ action: "skipped" });
    // The re-decision targets the SAME (worker, job) → updates in place, applied wins.
    expect(repo.upsertDecision.mock.calls[1]![0]).toMatchObject({
      workerId: WORKER_ID,
      jobId: JOB_ID,
      action: "applied",
    });
  });

  it("404s on an unknown job and emits nothing", async () => {
    const { svc, repo, events } = setup({ jobExists: false });
    await expect(svc.skip(WORKER_ID, JOB_ID, { reason: "other" }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.upsertDecision).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService — feed", () => {
  // Job 1 carries a bounded experience window + a pay band + a pay TYPE + a shift + card
  // content; job 2 carries NONE of them (all null) — the two shapes the worker app must
  // handle. `createdAt` differs on purpose: it is the feed's sort key (#1649) and the
  // source of `posted_at`, so a fixture where both were equal could not observe either.
  const OPEN_JOBS = [
    { id: "a0000000-0000-0000-0000-000000000001", tradeKey: "cnc_operator", title: "T1", city: "Pune", area: "PCMC", minExperienceYears: 2, maxExperienceYears: 5, payMin: 18000, payMax: 25000, payType: "in_hand", shift: "night", description: "D1", benefits: ["B1"], requirements: ["R1"], neededBy: "immediate", roleKind: "cnc_turner", createdAt: new Date("2026-06-01T00:00:00.000Z") },
    { id: "a0000000-0000-0000-0000-000000000002", tradeKey: "fitter", title: "T2", city: "Pune", area: null, minExperienceYears: null, maxExperienceYears: null, payMin: null, payMax: null, payType: null, shift: null, description: null, benefits: null, requirements: null, neededBy: null, roleKind: null, createdAt: new Date("2026-05-01T00:00:00.000Z") },
  ];

  it("returns coarse PII-free items with 1-based rank and emits one feed.shown per item", async () => {
    const { svc, events } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, {}, CTX);

    expect(out.jobs).toEqual([
      { job_id: OPEN_JOBS[0]!.id, trade_key: "cnc_operator", title: "T1", city: "Pune", area: "PCMC", min_experience_years: 2, max_experience_years: 5, pay_min: 18000, pay_max: 25000, shift: "night", description: "D1", benefits: ["B1"], requirements: ["R1"], needed_by: "immediate", pay_type: "in_hand", posted_at: "2026-06-01T00:00:00.000Z", role_kind: "cnc_turner", rank: 1 },
      { job_id: OPEN_JOBS[1]!.id, trade_key: "fitter", title: "T2", city: "Pune", area: null, min_experience_years: null, max_experience_years: null, pay_min: null, pay_max: null, shift: null, description: null, benefits: null, requirements: null, needed_by: null, pay_type: null, posted_at: "2026-05-01T00:00:00.000Z", role_kind: null, rank: 2 },
    ]);

    // One feed.shown per returned job (per-impression), batched via emitMany.
    expect(events.emitMany).toHaveBeenCalledOnce();
    const batch = events.emitMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({
      event_name: "feed.shown",
      actor: { actor_type: "worker", actor_id: WORKER_ID },
      subject: { subject_type: "job", subject_id: OPEN_JOBS[0]!.id },
      payload: { worker_id: WORKER_ID, job_id: OPEN_JOBS[0]!.id, rank: 1, score: 0, hot: false },
    });
    expect(batch[1]).toMatchObject({ payload: { rank: 2, score: 0, hot: false } });
    // role_kind is card art only — feed.shown's payload is unchanged (no schema change).
    for (const e of batch) expect(e.payload).not.toHaveProperty("role_kind");
  });

  it("emits nothing when there are no open jobs", async () => {
    const { svc, events } = setup({ openJobs: [] });
    const out = await svc.getFeed(WORKER_ID, 20, {}, CTX);
    expect(out.jobs).toEqual([]);
    expect(events.emitMany).not.toHaveBeenCalled();
  });

  it("returns ALL open jobs regardless of city — the alpha feed is LIBERAL (no location filter, no drop)", async () => {
    // Jobs spread across different cities: every one must come back, in order,
    // proving the feed applies no location/city filter and drops nothing.
    const acrossCities = [
      { id: "b0000000-0000-0000-0000-000000000001", tradeKey: "cnc_operator", title: "T1", city: "Pune", area: "PCMC", createdAt: new Date("2026-06-04T00:00:00.000Z") },
      { id: "b0000000-0000-0000-0000-000000000002", tradeKey: "fitter", title: "T2", city: "Chennai", area: null, createdAt: new Date("2026-06-03T00:00:00.000Z") },
      { id: "b0000000-0000-0000-0000-000000000003", tradeKey: "welder", title: "T3", city: "Rajkot", area: "GIDC", createdAt: new Date("2026-06-02T00:00:00.000Z") },
      { id: "b0000000-0000-0000-0000-000000000004", tradeKey: "vmc_setter", title: "T4", city: "Coimbatore", area: null, createdAt: new Date("2026-06-01T00:00:00.000Z") },
    ];
    const { svc, repo, events } = setup({ openJobs: acrossCities });
    const out = await svc.getFeed(WORKER_ID, 50, {}, CTX);

    // Every job returned (no drop), in the repository's deterministic order.
    expect(out.jobs).toHaveLength(acrossCities.length);
    expect(out.jobs.map((j) => j.job_id)).toEqual(acrossCities.map((j) => j.id));
    expect(out.jobs.map((j) => j.city)).toEqual(["Pune", "Chennai", "Rajkot", "Coimbatore"]);
    // The limit is passed straight through — no city/coords argument is invented.
    expect(repo.findOpenJobs).toHaveBeenCalledWith(WORKER_ID, 50, {});
    // One impression per returned job (no dedupe, no filtering).
    const batch = events.emitMany.mock.calls[0]![0] as unknown[];
    expect(batch).toHaveLength(acrossCities.length);
  });

  it("carries the job's experience window, passing BOTH nulls through un-coerced", async () => {
    // A missing window must stay null — NOT 0. A client reads [min ?? 0, max ??
    // infinity], so coercing a null min to 0 would be lossless here but coercing a
    // null max to 0 would collapse the window and hide the job from every band.
    const { svc } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, {}, CTX);

    expect(out.jobs[0]).toMatchObject({ min_experience_years: 2, max_experience_years: 5 });
    expect(out.jobs[1]!.min_experience_years).toBeNull();
    expect(out.jobs[1]!.max_experience_years).toBeNull();
  });

  it("carries a HALF-OPEN window (min set, max null = open-ended) without inventing a ceiling", async () => {
    const openEnded = [
      { id: "c0000000-0000-0000-0000-000000000001", tradeKey: "welder", title: "T1", city: "Rajkot", area: null, minExperienceYears: 5, maxExperienceYears: null, createdAt: new Date("2026-06-01T00:00:00.000Z") },
    ];
    const { svc } = setup({ openJobs: openEnded });
    const out = await svc.getFeed(WORKER_ID, 20, {}, CTX);

    // '5+ yrs' jobs are stored as [5, null]; the null max means infinity, and the
    // feed must not substitute a finite bound for it.
    expect(out.jobs[0]).toMatchObject({ min_experience_years: 5, max_experience_years: null });
  });

  // ── ADR-0024 final addendum: additive pay_min/pay_max/shift on the FeedItem ──

  it("carries pay_min/pay_max/shift additively, nulls passed through un-coerced", async () => {
    const { svc } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, {}, CTX);

    // Values pass through as stored (the band, never an exact salary)…
    expect(out.jobs[0]).toMatchObject({ pay_min: 18000, pay_max: 25000, shift: "night" });
    // …and a job with no band/shift keeps honest NULLs — never 0, never a
    // fabricated shift, never dropped (same doctrine as the experience window).
    expect(out.jobs[1]!.pay_min).toBeNull();
    expect(out.jobs[1]!.pay_max).toBeNull();
    expect(out.jobs[1]!.shift).toBeNull();
  });

  it("carries the card content additively (#1561), nulls passed through un-coerced", async () => {
    const { svc } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, {}, CTX);

    // Values pass through verbatim…
    expect(out.jobs[0]).toMatchObject({ description: "D1", benefits: ["B1"], requirements: ["R1"], needed_by: "immediate" });
    // …and a job with no content keeps honest NULLs — never "", never [], never dropped.
    expect(out.jobs[1]!.description).toBeNull();
    expect(out.jobs[1]!.benefits).toBeNull();
    expect(out.jobs[1]!.requirements).toBeNull();
    expect(out.jobs[1]!.needed_by).toBeNull();
  });

  it("stays backward-compatible: a consumer reading only the OLD FeedItem keys still works", async () => {
    const { svc } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, {}, CTX);

    // The pre-ADR-0024 shape is an INTACT SUBSET of every item (§8 additive-only):
    // an old client destructuring these keys sees exactly what it saw before.
    expect(out.jobs[0]).toMatchObject({
      job_id: OPEN_JOBS[0]!.id,
      trade_key: "cnc_operator",
      title: "T1",
      city: "Pune",
      area: "PCMC",
      min_experience_years: 2,
      max_experience_years: 5,
      rank: 1,
    });
    // …and the new keys are strictly additive — no old key was renamed/removed.
    const OLD_KEYS = ["job_id", "trade_key", "title", "city", "area", "min_experience_years", "max_experience_years", "rank"];
    for (const item of out.jobs) {
      for (const k of OLD_KEYS) expect(Object.keys(item)).toContain(k);
    }
  });

  it("does NOT leak pay/shift (or anything new) into the feed.shown payload — EXACTLY the old keys", async () => {
    const { svc, events } = setup({ openJobs: OPEN_JOBS });
    await svc.getFeed(WORKER_ID, 20, {}, CTX);

    // feed.shown is UNCHANGED by ADR-0024 (response-only fields): the payload
    // key set stays byte-exact {worker_id, job_id, rank, score, hot} — asserted
    // here against jobs that DO carry pay + shift, so a leak would be caught.
    const batch = events.emitMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
    for (const e of batch) {
      expect(Object.keys(e.payload as Record<string, unknown>).sort()).toEqual([
        "hot",
        "job_id",
        "rank",
        "score",
        "worker_id",
      ]);
      // Belt-and-braces: the band values themselves never appear either.
      expect(JSON.stringify(e.payload)).not.toContain("18000");
      expect(JSON.stringify(e.payload)).not.toContain("25000");
      expect(JSON.stringify(e.payload)).not.toContain("night");
    }
  });

  it("does NOT add the experience window to the feed.shown payload (no event change, no version bump)", async () => {
    const { svc, events } = setup({ openJobs: OPEN_JOBS });
    await svc.getFeed(WORKER_ID, 20, {}, CTX);

    // The payload contract stays exactly {worker_id, job_id, rank, score, hot} —
    // this is a RESPONSE-only field, so the events spine is unchanged and
    // feed.shown stays at version 1.
    const batch = events.emitMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
    for (const e of batch) {
      expect(Object.keys(e.payload as Record<string, unknown>).sort()).toEqual([
        "hot",
        "job_id",
        "rank",
        "score",
        "worker_id",
      ]);
    }
  });
});

describe("ApplicationsService — PII-free guarantees + ownership", () => {
  it("never puts PII (name/phone/employer/address/pay) in any emitted payload", async () => {
    const { svc, events } = setup({
      openJobs: [
        { id: "a0000000-0000-0000-0000-000000000001", tradeKey: "cnc_operator", title: "T1", city: "Pune", area: "PCMC", createdAt: new Date("2026-06-01T00:00:00.000Z") },
      ],
    });
    await svc.getFeed(WORKER_ID, 5, {}, CTX);
    await svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX);
    await svc.skip(WORKER_ID, JOB_ID, { reason: "wrong_trade" }, CTX);

    const emitted = [
      ...events.emit.mock.calls.map((c) => c[0]),
      ...events.emitMany.mock.calls.flatMap((c) => c[0] as Array<Record<string, unknown>>),
    ];
    // Every payload's keys are a strict subset of the allowed PII-free fields.
    const ALLOWED = new Set([
      "worker_id",
      "job_id",
      "rank",
      "score",
      "hot",
      "source_surface",
      "reason",
    ]);
    for (const e of emitted) {
      for (const key of Object.keys(e.payload as Record<string, unknown>)) {
        expect(ALLOWED.has(key), `unexpected payload key ${key}`).toBe(true);
      }
    }
  });

  it("uses the SESSION worker id for the upsert/event — a body-supplied id would be ignored", async () => {
    // The service signature takes workerId as its first arg (from @CurrentWorker);
    // the dto carries NO worker_id, so there is no path for a client to spoof one.
    const { svc, repo, events } = setup();
    await svc.apply(WORKER_ID, JOB_ID, { rank: null, source_surface: "share" }, CTX);
    expect(repo.upsertDecision.mock.calls[0]![0]).toMatchObject({ workerId: WORKER_ID });
    expect((events.emit.mock.calls[0]![0].payload as { worker_id: string }).worker_id).toBe(
      WORKER_ID,
    );
  });
});

/**
 * ADR-0036 CUTOVER GATE. `MATCH_V1_ENABLED` is a DEPLOY SWITCH: with it off, every
 * legacy path must be byte-identical to what shipped. These assert the negative — that
 * the V1 collaborators are never reached — which is the property the whole
 * "legacy paths stay intact behind the flag" posture rests on.
 */
describe("ApplicationsService — MATCH_V1_ENABLED=false keeps the legacy path", () => {
  it("serves the feed from `jobs` and never calls the V1 feed", async () => {
    const { svc, repo, matchFeed } = setup();
    await svc.getFeed(WORKER_ID, 10, {}, CTX);
    expect(repo.findOpenJobs).toHaveBeenCalledOnce();
    expect(matchFeed.getFeed).not.toHaveBeenCalled();
  });

  it("applies + skips through the legacy repository, never the V1 snapshot writer", async () => {
    const { svc, repo, matchApply } = setup();
    await svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX);
    await svc.skip(WORKER_ID, "33333333-3333-3333-3333-333333333333", { reason: "too_far" }, CTX);
    expect(repo.upsertDecision).toHaveBeenCalledTimes(2);
    expect(matchApply.buildSnapshot).not.toHaveBeenCalled();
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
  });

  it("emits feed.shown (v1), never feed.shown_v2", async () => {
    const { svc, events } = setup();
    await svc.getFeed(WORKER_ID, 10, {}, CTX);
    const names = (events.emitMany.mock.calls[0]?.[0] ?? []).map(
      (e) => (e as { event_name: string }).event_name,
    );
    for (const name of names) expect(name).toBe("feed.shown");
    expect(names).not.toContain("feed.shown_v2");
  });
});

/**
 * #1905 — the legacy arm's filters, at the seam where the RAW query becomes the repository's
 * typed input.
 *
 * TRADE KEY. The worker app sent its chip LABEL (`'CNC'`) as `trade_key`. No `jobs` row
 * carries anything but one of the 15 `TRADE_KEYS` slugs, so filtering on a label returned an
 * empty deck on every one-chip refetch. Owner ruling: an unknown value is IGNORED (no trade
 * filter), not 400'd, and the drop is logged so the app bug stays visible.
 *
 * SHIFT / PAY. Both were accepted by the DTO and never reached the query.
 */
describe("ApplicationsService — legacy /feed filters (#1905)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The filters `findOpenJobs` actually received on its one call. */
  const repoFilters = (repo: ReturnType<typeof setup>["repo"]) => {
    const calls = repo.findOpenJobs.mock.calls as unknown as [string, number, Record<string, unknown>][];
    expect(calls).toHaveLength(1);
    return calls[0]![2];
  };

  it("IGNORES a trade_key that is not a known slug: no trade filter at all, the arm is served whole", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, repo } = setup();
    await svc.getFeed(WORKER_ID, 50, { tradeKey: "CNC" }, CTX);

    // `undefined`, not `'CNC'`: forwarding the label is the bug (it matches no row).
    expect(repoFilters(repo).tradeKey).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("LOGS the dropped value PII-free: its length and the request id, never the value itself", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc } = setup();
    // A value that could plausibly be anything a client typed (here, a phone-shaped string).
    const raw = "Welder 9876543210";
    await svc.getFeed(WORKER_ID, 50, { tradeKey: raw }, CTX);

    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("trade_key");
    expect(line).toContain(`length=${raw.length}`);
    expect(line).toContain(CTX.requestId);
    expect(line).not.toContain("Welder");
    expect(line).not.toContain("9876543210");
    expect(line).not.toContain(WORKER_ID);
  });

  it("still FILTERS on a valid slug, exactly as before, and logs nothing", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, repo } = setup();
    await svc.getFeed(WORKER_ID, 50, { tradeKey: "cnc_operator", city: "Pune" }, CTX);

    expect(repoFilters(repo)).toMatchObject({ tradeKey: "cnc_operator", city: "Pune" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an empty trade_key as 'not sent': no filter, and not logged as a drop", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, repo } = setup();
    await svc.getFeed(WORKER_ID, 50, { tradeKey: "" }, CTX);

    expect(repoFilters(repo).tradeKey).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("an ignored trade_key does not take the OTHER filters down with it", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, repo } = setup();
    await svc.getFeed(WORKER_ID, 50, { tradeKey: "Welder", city: "Pune", shift: "night", payMin: 20000 }, CTX);

    expect(repoFilters(repo)).toEqual({
      tradeKey: undefined,
      city: "Pune",
      shift: "night",
      payMin: 20000,
    });
  });

  it("forwards shift and pay_min to the query (they were silently dropped before)", async () => {
    const { svc, repo } = setup();
    await svc.getFeed(WORKER_ID, 50, { shift: "rotational", payMin: 0 }, CTX);

    // `payMin: 0` survives: a falsy floor is still a floor the worker set.
    expect(repoFilters(repo)).toMatchObject({ shift: "rotational", payMin: 0 });
  });

  it("invents no filter the worker did not send (ADR-0036 Part 3: every default is off)", async () => {
    const { svc, repo } = setup();
    await svc.getFeed(WORKER_ID, 50, {}, CTX);

    const filters = repoFilters(repo);
    for (const key of ["tradeKey", "city", "shift", "payMin"]) {
      expect(filters[key]).toBeUndefined();
    }
  });

  it("leaves feed.shown exactly as it was: the filters are NOT in the payload", async () => {
    const { svc, events } = setup({
      openJobs: [
        { id: JOB_ID, tradeKey: "cnc_operator", title: "T", city: "Pune", area: null, shift: "night", payMax: 25000, createdAt: new Date("2026-06-01T00:00:00.000Z") },
      ],
    });
    await svc.getFeed(WORKER_ID, 50, { tradeKey: "cnc_operator", shift: "night", payMin: 20000 }, CTX);

    const batch = events.emitMany.mock.calls[0]![0] as Array<{ payload: Record<string, unknown> }>;
    expect(Object.keys(batch[0]!.payload).sort()).toEqual(["hot", "job_id", "rank", "score", "worker_id"]);
  });
});

/**
 * #1823 — FEED_POSTINGS_UNION_ENABLED is DARK BY DEFAULT, and dark means today's code path.
 * This file's config never sets it, so every case above is the flag-off contract; these pin
 * the negative directly. `findOpenPostingRef` is stubbed to REPORT AN OPEN POSTING, so a
 * leak of the union branch into the flag-off path would turn a 404 into a 200 here.
 */
describe("ApplicationsService — FEED_POSTINGS_UNION_ENABLED off keeps the jobs-only path", () => {
  it("never reads postings or wanted skills for the feed", async () => {
    const { svc, repo, workerSkills } = setup({ openJobs: [] });
    await svc.getFeed(WORKER_ID, 10, { city: "Pune" }, CTX);
    expect(repo.findOpenJobs).toHaveBeenCalledOnce();
    expect(repo.findOpenPostingsForFeed).not.toHaveBeenCalled();
    expect(workerSkills.listWantedSkillIds).not.toHaveBeenCalled();
  });

  it("never consults the posting table or the snapshot writer on apply/skip", async () => {
    const { svc, repo, matchApply } = setup();
    await svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX);
    await svc.skip(WORKER_ID, JOB_ID, { reason: "too_far" }, CTX);
    expect(repo.findOpenPostingRef).not.toHaveBeenCalled();
    for (const fn of Object.values(matchApply)) expect(fn).not.toHaveBeenCalled();
  });

  it("404s a posting-only id with no write and no event — exactly as before the union", async () => {
    const { svc, repo, events, matchApply } = setup({ jobExists: false });
    for (const decide of [
      () => svc.apply(WORKER_ID, JOB_ID, { rank: 1, source_surface: "feed" }, CTX),
      () => svc.skip(WORKER_ID, JOB_ID, { reason: "too_far" }, CTX),
    ]) {
      const err = await decide().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).message).toBe("Job not found");
    }
    expect(repo.findOpenPostingRef).not.toHaveBeenCalled();
    expect(repo.upsertDecision).not.toHaveBeenCalled();
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

/**
 * #1823 — THE OPS APPLICANTS READ SEES BOTH ID SPACES, ONE INDEXED READ AT A TIME.
 * Ungated (the flag is absent from this file's config): disarming the union must never hide
 * who already applied. The id space is resolved first so neither read is an OR that would
 * take the legacy path off `applications_job_id_idx`.
 */
describe("applicantsForJob — #1823 resolves the id space, then reads one column", () => {
  const POSTING_ID = "33333333-3333-3333-3333-333333333333";
  const row = (over: Record<string, unknown>) => ({
    workerId: WORKER_ID,
    action: "applied",
    reason: null,
    sourceSurface: "feed",
    rank: 1,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  });

  it("a `jobs` id reads job_id only — today's read, byte for byte", async () => {
    const { svc, repo } = setup();
    repo.findApplicantsByJob.mockResolvedValueOnce([row({}) as never]);
    const out = await svc.applicantsForJob(JOB_ID);
    expect(repo.legacyJobExists).toHaveBeenCalledWith(JOB_ID);
    expect(repo.findApplicantsByJob).toHaveBeenCalledWith(JOB_ID);
    expect(repo.findApplicantsByPosting).not.toHaveBeenCalled();
    expect(out.job_id).toBe(JOB_ID);
    expect(out.applicants).toHaveLength(1);
  });

  it("any other id reads job_posting_id — a posting's applicants are no longer invisible", async () => {
    const { svc, repo } = setup();
    repo.findApplicantsByPosting.mockResolvedValueOnce([
      row({ action: "skipped", reason: "too_far", rank: null }) as never,
    ]);
    const out = await svc.applicantsForJob(POSTING_ID);
    expect(repo.findApplicantsByPosting).toHaveBeenCalledWith(POSTING_ID);
    expect(repo.findApplicantsByJob).not.toHaveBeenCalled();
    // Same PII-free projection whichever id space answered — worker_id, never a name/phone.
    expect(out).toEqual({
      job_id: POSTING_ID,
      applicants: [
        {
          worker_id: WORKER_ID,
          action: "skipped",
          reason: "too_far",
          source_surface: "feed",
          rank: null,
          created_at: new Date("2026-10-01T00:00:00Z"),
          updated_at: new Date("2026-10-01T00:00:00Z"),
        },
      ],
    });
  });

  it("a failed id-space probe propagates — it is never read as 'not a job'", async () => {
    const { svc, repo } = setup();
    repo.legacyJobExists.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.applicantsForJob(JOB_ID)).rejects.toThrow("db down");
    expect(repo.findApplicantsByJob).not.toHaveBeenCalled();
    expect(repo.findApplicantsByPosting).not.toHaveBeenCalled();
  });
});

/**
 * #1051 — THE SEAM WHERE AN INTERNAL ID BECOMES SOMETHING A WORKER MAY READ.
 *
 * The repository projects `job_reach.matched_skill_id` because a V1 decision has no other
 * source for its subtitle: `job_postings` carries no trade key, so `trade_key` is NULL for
 * every one of them. Turning that id into a human string is a closed-set taxonomy lookup, and
 * it happens HERE. Two failures are possible on this line and each has already happened once
 * in this codebase:
 *
 *   - send nothing, and the client renders a place with no trade (#1051 — all 17 live cards);
 *   - send the id, and the client renders `mskill_mig_welder` in the reading position of a job
 *     title (#1027 — the risk the label exists to remove).
 *
 * `trade_key` deliberately keeps carrying the raw internal key: it is the audit-trail value,
 * clients are contractually told not to render it, and the worker app now refuses to.
 */
describe("applicationsForWorker — matched_skill_label (#1051)", () => {
  const ROW = {
    jobId: JOB_ID,
    tradeKey: null as string | null,
    title: "Welder — Day Shift",
    city: "Pune",
    area: null,
    action: "applied" as const,
    reason: null,
    sourceSurface: "match_v1" as const,
    rank: 1,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    matchedSkillId: null as string | null,
  };

  function serviceReturning(rows: Array<typeof ROW>) {
    const repo = { findApplicationsByWorker: vi.fn(async () => rows) };
    return new ApplicationsService(
      repo as unknown as ApplicationsRepository,
      {} as unknown as EventsService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it("resolves a known match-skill id to its human label", async () => {
    const svc = serviceReturning([{ ...ROW, matchedSkillId: "mskill_mig_welder" }]);
    const out = await svc.applicationsForWorker(WORKER_ID);

    expect(out.applications[0]!.matched_skill_label).toBe("MIG Welder");
  });

  it("is null for a legacy decision, which has no reach row at all", async () => {
    const svc = serviceReturning([{ ...ROW, tradeKey: "cnc_operator", matchedSkillId: null }]);
    const out = await svc.applicationsForWorker(WORKER_ID);

    // Null, not "" and not the trade key: the client falls back to `trade_key` itself for a
    // legacy row, and it can only do that if it can tell there is no label.
    expect(out.applications[0]!.matched_skill_label).toBeNull();
    expect(out.applications[0]!.trade_key).toBe("cnc_operator");
  });

  it("is null — never the id — for an id the taxonomy does not know", async () => {
    // THE FAIL-CLOSED CASE. `matchSkillLabel` returns undefined for an unknown id, and the
    // tempting `?? id` would put `mskill_something_new` straight onto a worker's card the
    // first time the corpus and the reach table disagree.
    const svc = serviceReturning([{ ...ROW, matchedSkillId: "mskill_not_in_the_corpus" }]);
    const out = await svc.applicationsForWorker(WORKER_ID);

    expect(out.applications[0]!.matched_skill_label).toBeNull();
  });

  it("puts no `mskill_` id anywhere a client could render it", async () => {
    // `trade_key` is exempt BY CONTRACT — it is the internal key, and it is NULL for V1 rows
    // anyway. Every other field is fair game for a subtitle, so none may carry an id.
    const svc = serviceReturning([{ ...ROW, matchedSkillId: "mskill_mig_welder" }]);
    const out = await svc.applicationsForWorker(WORKER_ID);
    const { trade_key: _tradeKey, ...renderable } = out.applications[0]!;

    expect(JSON.stringify(renderable)).not.toContain("mskill_");
  });

  it("sends the key at all — the #1051 regression was the field being absent", async () => {
    // The worker app reads `json['matched_skill_label']`. A response that omits the key parses
    // to null forever and the preferred branch is dead code, which is exactly what happened.
    const svc = serviceReturning([{ ...ROW, matchedSkillId: "mskill_mig_welder" }]);
    const out = await svc.applicationsForWorker(WORKER_ID);

    expect(Object.keys(out.applications[0]!)).toContain("matched_skill_label");
  });
});

import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
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
  const existingRows = new Set<string>();
  // Per-job applies counter, bumped only by incrementApplicantsReceived.
  const applicantsReceived = new Map<string, number>();
  const repo = {
    findJobById: vi.fn(async () => (jobExists ? JOB_ROW : undefined)),
    findOpenJobs: vi.fn(async () => opts.openJobs ?? []),
    upsertDecision: vi.fn(async (input: Record<string, unknown>) => {
      const key = `${String(input.workerId)}:${String(input.jobId)}`;
      const inserted = !existingRows.has(key);
      existingRows.add(key);
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
    findApplicationsByWorker: vi.fn(async () => []),
  };
  const events = {
    emit: vi.fn(async (params: Record<string, unknown>) => params),
    emitMany: vi.fn(async (list: Array<Record<string, unknown>>) => list),
  };
  const svc = new ApplicationsService(
    repo as unknown as ApplicationsRepository,
    events as unknown as EventsService,
  );
  // `countFor` reads the simulated denormalized jobs.applicants_received rollup.
  const countFor = (jobId: string) => applicantsReceived.get(jobId) ?? 0;
  return { svc, repo, events, countFor };
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

  it("ACCEPTED alpha limitation: a skip→apply flip on an existing row does NOT increment", async () => {
    const { svc, repo, countFor } = setup();
    await svc.skip(WORKER_A, JOB_A, { reason: "low_pay" }, CTX);
    // The row already exists from the skip → the apply is an UPDATE (inserted:false),
    // so the counter is NOT bumped. Documented alpha simplification, not a bug.
    await svc.apply(WORKER_A, JOB_A, { rank: null, source_surface: "feed" }, CTX);
    expect(repo.incrementApplicantsReceived).not.toHaveBeenCalled();
    expect(countFor(JOB_A)).toBe(0);
  });

  it("monotonic: an apply→skip flip never decrements the counter", async () => {
    const { svc, countFor } = setup();
    await svc.apply(WORKER_A, JOB_A, { rank: 1, source_surface: "feed" }, CTX);
    await svc.skip(WORKER_A, JOB_A, { reason: "other" }, CTX);
    expect(countFor(JOB_A)).toBe(1);
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
  // Job 1 carries a bounded experience window + a pay band + a shift; job 2
  // carries NONE of them (all null) — the two shapes the worker app must handle.
  const OPEN_JOBS = [
    { id: "a0000000-0000-0000-0000-000000000001", tradeKey: "cnc_operator", title: "T1", city: "Pune", area: "PCMC", minExperienceYears: 2, maxExperienceYears: 5, payMin: 18000, payMax: 25000, shift: "night" },
    { id: "a0000000-0000-0000-0000-000000000002", tradeKey: "fitter", title: "T2", city: "Pune", area: null, minExperienceYears: null, maxExperienceYears: null, payMin: null, payMax: null, shift: null },
  ];

  it("returns coarse PII-free items with 1-based rank and emits one feed.shown per item", async () => {
    const { svc, events } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, CTX);

    expect(out.jobs).toEqual([
      { job_id: OPEN_JOBS[0]!.id, trade_key: "cnc_operator", title: "T1", city: "Pune", area: "PCMC", min_experience_years: 2, max_experience_years: 5, pay_min: 18000, pay_max: 25000, shift: "night", rank: 1 },
      { job_id: OPEN_JOBS[1]!.id, trade_key: "fitter", title: "T2", city: "Pune", area: null, min_experience_years: null, max_experience_years: null, pay_min: null, pay_max: null, shift: null, rank: 2 },
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
  });

  it("emits nothing when there are no open jobs", async () => {
    const { svc, events } = setup({ openJobs: [] });
    const out = await svc.getFeed(WORKER_ID, 20, CTX);
    expect(out.jobs).toEqual([]);
    expect(events.emitMany).not.toHaveBeenCalled();
  });

  it("returns ALL open jobs regardless of city — the alpha feed is LIBERAL (no location filter, no drop)", async () => {
    // Jobs spread across different cities: every one must come back, in order,
    // proving the feed applies no location/city filter and drops nothing.
    const acrossCities = [
      { id: "b0000000-0000-0000-0000-000000000001", tradeKey: "cnc_operator", title: "T1", city: "Pune", area: "PCMC" },
      { id: "b0000000-0000-0000-0000-000000000002", tradeKey: "fitter", title: "T2", city: "Chennai", area: null },
      { id: "b0000000-0000-0000-0000-000000000003", tradeKey: "welder", title: "T3", city: "Rajkot", area: "GIDC" },
      { id: "b0000000-0000-0000-0000-000000000004", tradeKey: "vmc_setter", title: "T4", city: "Coimbatore", area: null },
    ];
    const { svc, repo, events } = setup({ openJobs: acrossCities });
    const out = await svc.getFeed(WORKER_ID, 50, CTX);

    // Every job returned (no drop), in the repository's deterministic order.
    expect(out.jobs).toHaveLength(acrossCities.length);
    expect(out.jobs.map((j) => j.job_id)).toEqual(acrossCities.map((j) => j.id));
    expect(out.jobs.map((j) => j.city)).toEqual(["Pune", "Chennai", "Rajkot", "Coimbatore"]);
    // The limit is passed straight through — no city/coords argument is invented.
    expect(repo.findOpenJobs).toHaveBeenCalledWith(50);
    // One impression per returned job (no dedupe, no filtering).
    const batch = events.emitMany.mock.calls[0]![0] as unknown[];
    expect(batch).toHaveLength(acrossCities.length);
  });

  it("carries the job's experience window, passing BOTH nulls through un-coerced", async () => {
    // A missing window must stay null — NOT 0. A client reads [min ?? 0, max ??
    // infinity], so coercing a null min to 0 would be lossless here but coercing a
    // null max to 0 would collapse the window and hide the job from every band.
    const { svc } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, CTX);

    expect(out.jobs[0]).toMatchObject({ min_experience_years: 2, max_experience_years: 5 });
    expect(out.jobs[1]!.min_experience_years).toBeNull();
    expect(out.jobs[1]!.max_experience_years).toBeNull();
  });

  it("carries a HALF-OPEN window (min set, max null = open-ended) without inventing a ceiling", async () => {
    const openEnded = [
      { id: "c0000000-0000-0000-0000-000000000001", tradeKey: "welder", title: "T1", city: "Rajkot", area: null, minExperienceYears: 5, maxExperienceYears: null },
    ];
    const { svc } = setup({ openJobs: openEnded });
    const out = await svc.getFeed(WORKER_ID, 20, CTX);

    // '5+ yrs' jobs are stored as [5, null]; the null max means infinity, and the
    // feed must not substitute a finite bound for it.
    expect(out.jobs[0]).toMatchObject({ min_experience_years: 5, max_experience_years: null });
  });

  // ── ADR-0024 final addendum: additive pay_min/pay_max/shift on the FeedItem ──

  it("carries pay_min/pay_max/shift additively, nulls passed through un-coerced", async () => {
    const { svc } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, CTX);

    // Values pass through as stored (the band, never an exact salary)…
    expect(out.jobs[0]).toMatchObject({ pay_min: 18000, pay_max: 25000, shift: "night" });
    // …and a job with no band/shift keeps honest NULLs — never 0, never a
    // fabricated shift, never dropped (same doctrine as the experience window).
    expect(out.jobs[1]!.pay_min).toBeNull();
    expect(out.jobs[1]!.pay_max).toBeNull();
    expect(out.jobs[1]!.shift).toBeNull();
  });

  it("stays backward-compatible: a consumer reading only the OLD FeedItem keys still works", async () => {
    const { svc } = setup({ openJobs: OPEN_JOBS });
    const out = await svc.getFeed(WORKER_ID, 20, CTX);

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
    await svc.getFeed(WORKER_ID, 20, CTX);

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
    await svc.getFeed(WORKER_ID, 20, CTX);

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
        { id: "a0000000-0000-0000-0000-000000000001", tradeKey: "cnc_operator", title: "T1", city: "Pune", area: "PCMC" },
      ],
    });
    await svc.getFeed(WORKER_ID, 5, CTX);
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

import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { JobSpec } from "@badabhai/reach-engine";
import { ReachService } from "./reach.service";
import type { JobSource } from "./reach.job-source";
import type { JobSignalRow } from "./reach.repository";
import type { WorkerProfileSignalRow } from "./reach.mappers";

const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

const JOB_A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const JOB_B = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_C = "2c3d4e5f-6a7b-4c8d-89e0-1f2a3b4c5d6e";

function jobSpec(jobId: string, roleIds: string[]): JobSpec {
  return { jobId, roleIds, city: "pune", minExperienceYears: 1, payMin: 18000, payMax: 30000 };
}

/** A worker signal row. `uuid(n)` builds a deterministic valid UUID. */
function uuid(n: number): string {
  const h = n.toString(16).padStart(12, "0");
  return `33333333-3333-4333-8333-${h}`;
}

function row(n: number, overrides: Partial<WorkerProfileSignalRow> = {}): WorkerProfileSignalRow {
  return {
    workerId: uuid(n),
    canonicalRoleId: "vmc_operator",
    canonicalTradeId: "cnc_vmc",
    experience: { total_years: 5 },
    salaryExpectation: { amount_min: 22000, period: "monthly" },
    locationPreference: { preferred_cities: ["pune"] },
    availability: { status: "immediate" },
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

/** An all-blank worker (signals null) — must STILL appear (sort-never-block). */
function blankRow(n: number): WorkerProfileSignalRow {
  return {
    workerId: uuid(n),
    canonicalRoleId: null,
    canonicalTradeId: null,
    experience: {},
    salaryExpectation: {},
    locationPreference: {},
    availability: {},
    updatedAt: null,
  };
}

/** An off-trade worker — appears, never penalized out of the result. */
function offTradeRow(n: number): WorkerProfileSignalRow {
  return row(n, { canonicalRoleId: "welder", canonicalTradeId: "fabrication" });
}

function makeJobSource(jobs: JobSpec[]): JobSource {
  return {
    getJobSpec: vi.fn(async (id: string) => jobs.find((j) => j.jobId === id) ?? null),
    listOpenJobSpecs: vi.fn(async () => jobs.map((j) => ({ ...j }))),
  };
}

function make(rows: WorkerProfileSignalRow[], jobs: JobSpec[]) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const emitMany = vi.fn().mockResolvedValue([]);
  const repo = {
    listSignalRows: vi.fn().mockResolvedValue(rows),
    // #1898: the payer-owned list reads ONLY the job's appliers. Default: every row applied, so
    // the shape/event tests below read the same rows; the applier tests override it.
    listApplicantSignalRowsForJob: vi.fn(async (_jobId: string) => rows),
    findSignalRowByWorkerId: vi.fn(async (id: string) => rows.find((r) => r.workerId === id)),
    // Payer-scoped ownership read (PR2). Default: NOT owned (undefined) — the no-oracle
    // resolution that maps absent AND other-payer to the same neutral 404. Tests that
    // exercise ownership override it with mockResolvedValue(ownedRow(...)).
    findOwnedJobSignalRowById: vi.fn(async () => undefined as JobSignalRow | undefined),
  };
  const jobSource = makeJobSource(jobs);
  const svc = new ReachService(repo as never, { emit, emitMany } as never, jobSource);
  // feed.shown is emitted as ONE emitMany batch per view (W1); flatten all batches to the
  // individual event params for assertions.
  const emitted = (): Record<string, unknown>[] =>
    emitMany.mock.calls.flatMap((c) => c[0] as Record<string, unknown>[]);
  return { svc, emit, emitMany, emitted, repo, jobSource };
}

const PII_PATTERNS = ["full_name", "phone", "fullName", "address", "employer"];

/** Assert an emit param is an UNKEYED, PII-free feed.shown event. */
function assertFeedShownEmit(arg: Record<string, unknown>) {
  expect(arg.event_name).toBe("feed.shown");
  // D7: UNKEYED — no idempotencyKey on any feed.shown emit.
  expect(arg).not.toHaveProperty("idempotencyKey");
  const payload = arg.payload as Record<string, unknown>;
  // Payload has exactly the FeedShownPayload keys — no pushEligible, no PII.
  expect(Object.keys(payload).sort()).toEqual(["hot", "job_id", "rank", "score", "worker_id"]);
  expect(payload).not.toHaveProperty("pushEligible");
  const serialized = JSON.stringify(arg);
  for (const p of PII_PATTERNS) expect(serialized).not.toContain(p);
}

describe("ReachService — View A (applicants for a job)", () => {
  it("404s for an unknown job and emits nothing", async () => {
    const { svc, emit, emitMany } = make([row(1)], []);
    await expect(
      svc.applicantsForJob("00000000-0000-4000-8000-000000000000", CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(emit).not.toHaveBeenCalled();
    expect(emitMany).not.toHaveBeenCalled();
  });

  it("count in == count out: every worker appears (incl. all-blank + off-trade)", async () => {
    const pool = [row(1), blankRow(2), offTradeRow(3), row(4), blankRow(5)];
    const { svc, emitted } = make(pool, [jobSpec(JOB_A, ["vmc_operator"])]);

    const res = await svc.applicantsForJob(JOB_A, CTX as never);

    // The view orders; it never filters.
    expect(res.applicants.length).toBe(pool.length);
    const outIds = new Set(res.applicants.map((a) => a.workerId));
    for (const r of pool) expect(outIds.has(r.workerId)).toBe(true);
    // One feed.shown per rendered row.
    expect(emitted().length).toBe(pool.length);
  });

  it("renders faceless rows: ranking fields + faceless bands only (no PII keys)", async () => {
    const { svc } = make([row(1), row(2)], [jobSpec(JOB_A, ["vmc_operator"])]);
    const res = await svc.applicantsForJob(JOB_A, CTX as never);
    for (const a of res.applicants) {
      expect(Object.keys(a).sort()).toEqual(
        [
          "cityLabel",
          "components",
          "experienceBand",
          "hot",
          "pushEligible",
          "rank",
          "score",
          "tradeLabel",
          "workerId",
        ].sort(),
      );
    }
    expect(JSON.stringify(res)).not.toMatch(/full_name|phone|address|employer/);
  });

  it("grafts faceless bands derived from the worker's projected signals (View A)", async () => {
    // canonicalRoleId resolves to a taxonomy name; total_years -> coarse band; city slug.
    const r = row(1, {
      canonicalRoleId: "role_vmc_operator",
      experience: { total_years: 7 },
      locationPreference: { preferred_cities: ["pune"] },
    });
    const { svc } = make([r], [jobSpec(JOB_A, ["role_vmc_operator"])]);
    const res = await svc.applicantsForJob(JOB_A, CTX as never);
    const a = res.applicants.find((x) => x.workerId === r.workerId)!;
    expect(a.tradeLabel).toBe("VMC Operator"); // taxonomy name, not the raw id
    expect(a.experienceBand).toBe("6-10 yrs");
    expect(a.cityLabel).toBe("pune");
  });

  it("bands are response-only — they never leak into a feed.shown payload", async () => {
    const { svc, emitted } = make(
      [row(1, { canonicalRoleId: "role_vmc_operator", experience: { total_years: 7 } })],
      [jobSpec(JOB_A, ["role_vmc_operator"])],
    );
    await svc.applicantsForJob(JOB_A, CTX as never);
    for (const param of emitted()) {
      const payload = param.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["hot", "job_id", "rank", "score", "worker_id"]);
      expect(payload).not.toHaveProperty("tradeLabel");
      expect(payload).not.toHaveProperty("experienceBand");
      expect(payload).not.toHaveProperty("cityLabel");
    }
  });

  it("a blank worker still appears with all-null bands (sort-never-block)", async () => {
    const { svc } = make([blankRow(9)], [jobSpec(JOB_A, ["role_vmc_operator"])]);
    const res = await svc.applicantsForJob(JOB_A, CTX as never);
    const a = res.applicants.find((x) => x.workerId === uuid(9))!;
    expect(a).toBeDefined();
    expect(a.experienceBand).toBeNull();
    expect(a.tradeLabel).toBeNull();
    expect(a.cityLabel).toBeNull();
  });

  it("emits UNKEYED, PII-free feed.shown with no pushEligible field in the payload", async () => {
    const { svc, emitted } = make([row(1), row(2), row(3)], [jobSpec(JOB_A, ["vmc_operator"])]);
    const res = await svc.applicantsForJob(JOB_A, CTX as never);

    const params = emitted();
    expect(params.length).toBe(3);
    for (const p of params) assertFeedShownEmit(p);

    // pushEligible is present in the RESPONSE but absent from every event payload.
    expect(res.applicants[0]).toHaveProperty("pushEligible");
    for (const p of params) {
      expect(p.payload).not.toHaveProperty("pushEligible");
    }
  });

  it("feed.shown carries the row's own rank/score/hot and worker/job ids", async () => {
    const { svc, emitted } = make([row(1), row(2)], [jobSpec(JOB_A, ["vmc_operator"])]);
    const res = await svc.applicantsForJob(JOB_A, CTX as never);
    const byWorker = new Map(res.applicants.map((a) => [a.workerId, a]));
    for (const param of emitted()) {
      const p = param.payload as Record<string, unknown>;
      const a = byWorker.get(p.worker_id as string)!;
      expect(p.job_id).toBe(JOB_A);
      expect(p.rank).toBe(a.rank);
      expect(p.score).toBe(a.score);
      expect(p.hot).toBe(a.hot);
    }
  });
});

describe("ReachService — Payer-self View A (applicantsForOwnedJob, ADR-0019 R22)", () => {
  const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";

  /** A faceless owned job signal row (the repo's payer-scoped read result). */
  function ownedRow(jobId: string): JobSignalRow {
    return {
      jobId,
      tradeKey: "cnc_milling",
      city: "pune",
      payMin: 18000,
      payMax: 30000,
      minExperienceYears: 1,
      maxExperienceYears: 8,
      neededBy: "immediate",
    };
  }

  it("resolves the job via the PAYER-SCOPED ownership read (jobId + session payer)", async () => {
    const { svc, repo } = make([row(1)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(ownedRow(JOB_A));
    await svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never);
    expect(repo.findOwnedJobSignalRowById).toHaveBeenCalledWith(JOB_A, PAYER);
  });

  it("an unknown OR not-owned job → IDENTICAL neutral 404, emits nothing (XB-A + no-oracle)", async () => {
    const { svc, emit, emitMany, repo } = make([row(1), row(2)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(undefined); // absent OR other-payer
    await expect(svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(emit).not.toHaveBeenCalled();
    expect(emitMany).not.toHaveBeenCalled();
  });

  it("count in == count out over the APPLIERS + faceless rows, identical to the ops View A shape", async () => {
    const appliers = [row(1), blankRow(2), offTradeRow(3), row(4)];
    const { svc, emitted, repo } = make(appliers, []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(ownedRow(JOB_A));

    const res = await svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never);

    expect(res.jobId).toBe(JOB_A);
    // The core orders the appliers, never filters them — even blank + off-trade appliers stay.
    expect(res.applicants.length).toBe(appliers.length);
    for (const a of res.applicants) {
      expect(Object.keys(a).sort()).toEqual(
        [
          "cityLabel",
          "components",
          "experienceBand",
          "hot",
          "pushEligible",
          "rank",
          "score",
          "tradeLabel",
          "workerId",
        ].sort(),
      );
    }
    expect(emitted().length).toBe(appliers.length);
  });

  it("#1898: lists ONLY the workers who applied — a non-applier never appears, however well he scores", async () => {
    const applier = offTradeRow(1); // a weak match who DID apply
    const nonAppliers = [row(2), row(3)]; // strong matches who did NOT
    const { svc, repo, emitted } = make([applier, ...nonAppliers], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(ownedRow(JOB_A));
    repo.listApplicantSignalRowsForJob.mockResolvedValue([applier]);

    const res = await svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never);

    expect(res.applicants.map((a) => a.workerId)).toEqual([applier.workerId]);
    // The pool is never read on the payer path, and no impression names a non-applier.
    expect(repo.listSignalRows).not.toHaveBeenCalled();
    expect(repo.listApplicantSignalRowsForJob).toHaveBeenCalledWith(JOB_A);
    const shown = emitted().map((e) => (e.payload as { worker_id: string }).worker_id);
    expect(shown).toEqual([applier.workerId]);
    for (const n of nonAppliers) expect(JSON.stringify(res)).not.toContain(n.workerId);
  });

  it("#1898: an owned job nobody applied to → an EMPTY list (200), not a 404, and no impression", async () => {
    const { svc, repo, emitMany, emitted } = make([row(1), row(2)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(ownedRow(JOB_A));
    repo.listApplicantSignalRowsForJob.mockResolvedValue([]);

    const res = await svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never);

    expect(res).toEqual({ jobId: JOB_A, applicants: [] });
    expect(emitted()).toHaveLength(0);
    expect(emitMany.mock.calls.every((c) => (c[0] as unknown[]).length === 0)).toBe(true);
  });

  it("#1898: the appliers are read by the job id the OWNERSHIP read returned", async () => {
    const { svc, repo } = make([row(1)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(ownedRow(JOB_A));
    await svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never);
    expect(repo.listApplicantSignalRowsForJob).toHaveBeenCalledOnce();
    expect(repo.listApplicantSignalRowsForJob).toHaveBeenCalledWith(JOB_A);
  });

  it("emits feed.shown with the PAYER actor (actor_id == session payer), payload PII-free + payer-free", async () => {
    const { svc, emitted, repo } = make([row(1), row(2), row(3)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(ownedRow(JOB_A));

    await svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never);

    const params = emitted();
    expect(params.length).toBe(3);
    for (const param of params) {
      // Reuses the same UNKEYED, PII-free feed.shown contract as the ops path.
      assertFeedShownEmit(param);
      // Actor is the verified session payer — payer_id rides actor_id (opaque), never the payload.
      expect(param.actor).toEqual({ actor_type: "payer", actor_id: PAYER });
      // The payer_id MUST NOT appear in the payload (the impression is faceless about the worker).
      expect(JSON.stringify(param.payload)).not.toContain(PAYER);
      const payload = param.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty("payer_id");
    }
  });
});

describe("ReachService — tryApplicantsForOwnedJob (the #1823 payer-list source switch)", () => {
  const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";
  const OWNED: JobSignalRow = {
    jobId: JOB_A,
    tradeKey: "cnc_milling",
    city: "pune",
    payMin: null,
    payMax: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    neededBy: null,
  };

  it("an owned job → the SAME list applicantsForOwnedJob serves, from ONE ownership read", async () => {
    // Recency is scored against "now"; pin the clock so the two lists are comparable.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      const pool = [row(1), row(2)];
      const a = make(pool, []);
      a.repo.findOwnedJobSignalRowById.mockResolvedValue(OWNED);
      const tried = await a.svc.tryApplicantsForOwnedJob(JOB_A, PAYER, CTX as never);
      expect(a.repo.findOwnedJobSignalRowById).toHaveBeenCalledOnce();
      expect(a.repo.findOwnedJobSignalRowById).toHaveBeenCalledWith(JOB_A, PAYER);

      const b = make(pool, []);
      b.repo.findOwnedJobSignalRowById.mockResolvedValue(OWNED);
      expect(tried).toEqual(await b.svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never));
    } finally {
      vi.useRealTimers();
    }
  });

  it("an owned job still emits its payer-actor feed.shown batch", async () => {
    const { svc, repo, emitted } = make([row(1), row(2)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(OWNED);
    await svc.tryApplicantsForOwnedJob(JOB_A, PAYER, CTX as never);
    expect(emitted()).toHaveLength(2);
    for (const e of emitted()) expect(e.actor).toEqual({ actor_type: "payer", actor_id: PAYER });
  });

  it("an unknown OR another payer's job → undefined, the same answer for both (no-oracle)", async () => {
    const { svc, repo } = make([row(1)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(undefined);
    await expect(svc.tryApplicantsForOwnedJob(JOB_A, PAYER, CTX as never)).resolves.toBeUndefined();
  });

  it("a miss reads no workers, ranks nothing and emits nothing", async () => {
    const { svc, repo, emit, emitMany } = make([row(1)], []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(undefined);
    await svc.tryApplicantsForOwnedJob(JOB_A, PAYER, CTX as never);
    expect(repo.listSignalRows).not.toHaveBeenCalled();
    expect(repo.listApplicantSignalRowsForJob).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(emitMany).not.toHaveBeenCalled();
  });

  it("a DB error propagates instead of reading as not-owned (fail closed)", async () => {
    const { svc, repo } = make([], []);
    repo.findOwnedJobSignalRowById.mockRejectedValue(new Error("connection terminated"));
    await expect(svc.tryApplicantsForOwnedJob(JOB_A, PAYER, CTX as never)).rejects.toThrow(
      "connection terminated",
    );
  });
});

describe("ReachService — View B (job feed for a worker)", () => {
  it("404s when the worker has no profile and emits nothing", async () => {
    const { svc, emit, emitMany } = make([], [jobSpec(JOB_A, ["vmc_operator"])]);
    await expect(svc.feedForWorker(uuid(99), CTX as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(emit).not.toHaveBeenCalled();
    expect(emitMany).not.toHaveBeenCalled();
  });

  it("count in == count out: one feed row per candidate job", async () => {
    const jobs = [
      jobSpec(JOB_A, ["vmc_operator"]),
      jobSpec(JOB_B, ["cnc_operator"]),
      jobSpec(JOB_C, ["cnc_programmer"]),
    ];
    const { svc, emitted } = make([row(1)], jobs);
    const res = await svc.feedForWorker(uuid(1), CTX as never);
    expect(res.feed.length).toBe(jobs.length);
    expect(emitted().length).toBe(jobs.length);
  });

  it("assigns deterministic best-first order with 1-based rank (reproducible)", async () => {
    const jobs = [
      jobSpec(JOB_C, ["cnc_programmer"]), // off-trade for a vmc worker
      jobSpec(JOB_A, ["vmc_operator"]), // on-trade
      jobSpec(JOB_B, ["cnc_operator"]),
    ];
    const { svc } = make([row(1)], jobs);
    const a = await svc.feedForWorker(uuid(1), CTX as never);
    const b = await svc.feedForWorker(uuid(1), CTX as never);
    // 1-based, contiguous rank.
    expect(a.feed.map((f) => f.rank)).toEqual([1, 2, 3]);
    // Sorted by score desc.
    const scores = a.feed.map((f) => f.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    // Deterministic across calls.
    expect(a.feed.map((f) => f.jobId)).toEqual(b.feed.map((f) => f.jobId));
  });

  it("View B rows omit hot AND pushEligible (D4) — only jobId/rank/score/components", async () => {
    const jobs = [jobSpec(JOB_A, ["vmc_operator"]), jobSpec(JOB_B, ["cnc_operator"])];
    const { svc } = make([row(1)], jobs);
    const res = await svc.feedForWorker(uuid(1), CTX as never);
    for (const f of res.feed) {
      expect(Object.keys(f).sort()).toEqual(["components", "jobId", "rank", "score"].sort());
      expect(f).not.toHaveProperty("hot");
      expect(f).not.toHaveProperty("pushEligible");
    }
  });

  it("emits one UNKEYED feed.shown per row with hot:false (honest for View B)", async () => {
    const jobs = [jobSpec(JOB_A, ["vmc_operator"]), jobSpec(JOB_B, ["cnc_operator"])];
    const { svc, emitted } = make([row(1)], jobs);
    await svc.feedForWorker(uuid(1), CTX as never);
    const params = emitted();
    expect(params.length).toBe(jobs.length);
    for (const param of params) {
      assertFeedShownEmit(param);
      const payload = param.payload as Record<string, unknown>;
      expect(payload.hot).toBe(false);
      expect(payload.worker_id).toBe(uuid(1));
    }
  });
});

describe("ReachService — appliersForOwnedJobs + emitPayerFeedShown (the payer inbox)", () => {
  const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";
  const signal = (jobId: string): JobSignalRow => ({
    jobId,
    tradeKey: "cnc_milling",
    city: "pune",
    payMin: 18000,
    payMax: 30000,
    minExperienceYears: 1,
    maxExperienceYears: 8,
    neededBy: "immediate",
  });

  /** A ReachService over ONE fake table set, answering both the per-job and the batched reads. */
  function batched(owned: string[], appliers: Record<string, WorkerProfileSignalRow[]>) {
    const isOwned = (id: string, payerId: string) => payerId === PAYER && owned.includes(id);
    const repo = {
      findOwnedJobSignalRowById: vi.fn(async (id: string, payerId: string) =>
        isOwned(id, payerId) ? signal(id) : undefined,
      ),
      listApplicantSignalRowsForJob: vi.fn(async (id: string) => appliers[id] ?? []),
      findOwnedJobSignalRowsByIds: vi.fn(async (ids: readonly string[], payerId: string) =>
        ids.filter((id) => isOwned(id, payerId)).map(signal),
      ),
      listApplicantSignalRowsForJobs: vi.fn(async (ids: readonly string[]) =>
        ids.flatMap((jobId) => (appliers[jobId] ?? []).map((row) => ({ jobId, row }))),
      ),
    };
    const emitMany = vi.fn().mockResolvedValue([]);
    const svc = new ReachService(repo as never, { emit: vi.fn(), emitMany } as never, {} as never);
    const emitted = (): Record<string, unknown>[] =>
      emitMany.mock.calls.flatMap((c) => c[0] as Record<string, unknown>[]);
    return { svc, repo, emitMany, emitted };
  }

  it("each owned job's list is exactly the per-job list, from TWO reads for all jobs, emitting nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      const appliers = { [JOB_A]: [row(1), offTradeRow(2), blankRow(3)], [JOB_B]: [row(4)] };
      const d = batched([JOB_A, JOB_B], appliers);
      const byJob = await d.svc.appliersForOwnedJobs([JOB_A, JOB_B], PAYER);
      expect(d.repo.findOwnedJobSignalRowsByIds).toHaveBeenCalledOnce();
      expect(d.repo.listApplicantSignalRowsForJobs).toHaveBeenCalledOnce();
      expect(d.emitMany).not.toHaveBeenCalled();
      for (const jobId of [JOB_A, JOB_B]) {
        const perJob = await d.svc.tryApplicantsForOwnedJob(jobId, PAYER, CTX as never);
        expect(byJob.get(jobId)).toStrictEqual(perJob!.applicants);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a job the payer does not own is absent and its appliers are never read", async () => {
    const d = batched([JOB_A], { [JOB_A]: [row(1)], [JOB_C]: [row(2)] });
    const byJob = await d.svc.appliersForOwnedJobs([JOB_A, JOB_C], PAYER);
    expect([...byJob.keys()]).toEqual([JOB_A]);
    expect(d.repo.listApplicantSignalRowsForJobs).toHaveBeenCalledWith([JOB_A]);
  });

  it("nothing owned → no applier read; no ids → no read at all", async () => {
    const d = batched([], {});
    expect((await d.svc.appliersForOwnedJobs([JOB_A], PAYER)).size).toBe(0);
    expect(d.repo.listApplicantSignalRowsForJobs).not.toHaveBeenCalled();
    expect((await d.svc.appliersForOwnedJobs([], PAYER)).size).toBe(0);
    expect(d.repo.findOwnedJobSignalRowsByIds).toHaveBeenCalledOnce();
  });

  it("emitPayerFeedShown writes the per-job impression for each given row — one batch, payer actor", async () => {
    const d = batched([JOB_A], { [JOB_A]: [row(1), row(2)] });
    const perJob = await d.svc.tryApplicantsForOwnedJob(JOB_A, PAYER, CTX as never);
    const fromList = d.emitted();
    d.emitMany.mockClear();
    await d.svc.emitPayerFeedShown(
      perJob!.applicants.map((r) => ({ jobId: JOB_A, row: r })),
      PAYER,
      CTX as never,
    );
    expect(d.emitMany).toHaveBeenCalledOnce();
    expect(d.emitted()).toStrictEqual(fromList);
    for (const e of d.emitted()) assertFeedShownEmit(e);
  });
});

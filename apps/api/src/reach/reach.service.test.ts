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

  it("count in == count out + faceless rows, identical to the ops View A shape", async () => {
    const pool = [row(1), blankRow(2), offTradeRow(3), row(4)];
    const { svc, emitted, repo } = make(pool, []);
    repo.findOwnedJobSignalRowById.mockResolvedValue(ownedRow(JOB_A));

    const res = await svc.applicantsForOwnedJob(JOB_A, PAYER, CTX as never);

    expect(res.jobId).toBe(JOB_A);
    expect(res.applicants.length).toBe(pool.length); // sort-never-block
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
    expect(emitted().length).toBe(pool.length);
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

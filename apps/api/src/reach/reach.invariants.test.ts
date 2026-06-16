import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  FeedShownPayload,
  ApplicationSubmittedPayload,
  ApplicationSkippedPayload,
} from "@badabhai/event-schema";
import type { JobSpec } from "@badabhai/reach-engine";
import { ReachService } from "./reach.service";
import type { JobSource } from "./reach.job-source";
import type { WorkerProfileSignalRow } from "./reach.mappers";

const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

// ---------------------------------------------------------------------------
// Deterministic PRNG so the property test is reproducible.
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function uuid(n: number): string {
  return `44444444-4444-4444-8444-${n.toString(16).padStart(12, "0")}`;
}
function jobUuid(n: number): string {
  return `55555555-5555-4555-8555-${n.toString(16).padStart(12, "0")}`;
}

const ROLES = ["vmc_operator", "cnc_operator", "cnc_programmer", "welder", "fitter"];
const AVAIL = ["immediate", "notice_period", "not_looking", "unknown", "on_holiday"];

/** A random, possibly-degenerate signal row (blanks, garbage, off-trade all allowed). */
function randomRow(rng: () => number, n: number): WorkerProfileSignalRow {
  const blank = rng() < 0.25;
  if (blank) {
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
  return {
    workerId: uuid(n),
    canonicalRoleId: ROLES[Math.floor(rng() * ROLES.length)]!,
    canonicalTradeId: "cnc_vmc",
    experience: rng() < 0.3 ? "garbage" : { total_years: Math.floor(rng() * 20) },
    salaryExpectation: { amount_min: Math.floor(rng() * 50000), period: "monthly" },
    locationPreference: { preferred_cities: ["pune"] },
    availability: { status: AVAIL[Math.floor(rng() * AVAIL.length)] },
    updatedAt: rng() < 0.2 ? null : new Date(Date.now() - Math.floor(rng() * 1e10)),
  };
}

function randomJob(rng: () => number, n: number): JobSpec {
  return {
    jobId: jobUuid(n),
    roleIds: [ROLES[Math.floor(rng() * ROLES.length)]!],
    city: "pune",
    minExperienceYears: Math.floor(rng() * 5),
    payMin: 15000 + Math.floor(rng() * 20000),
  };
}

function makeSvc(rows: WorkerProfileSignalRow[], jobs: JobSpec[]) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const emitMany = vi.fn().mockResolvedValue([]);
  const repo = {
    listSignalRows: vi.fn().mockResolvedValue(rows),
    findSignalRowByWorkerId: vi.fn(async (id: string) => rows.find((r) => r.workerId === id)),
  };
  const jobSource: JobSource = {
    getJobSpec: vi.fn(async (id: string) => jobs.find((j) => j.jobId === id) ?? null),
    listOpenJobSpecs: vi.fn(async () => jobs.map((j) => ({ ...j }))),
  };
  // feed.shown rows are emitted as ONE emitMany batch per view (W1); count across batches.
  const emittedCount = (): number =>
    emitMany.mock.calls.reduce((sum, c) => sum + (c[0] as unknown[]).length, 0);
  return {
    svc: new ReachService(repo as never, { emit, emitMany } as never, jobSource),
    emit,
    emittedCount,
  };
}

describe("Reach invariants — SORT-NEVER-BLOCK (count in == count out)", () => {
  it("View A: response length == pool length across 50 random pools", async () => {
    for (let trial = 0; trial < 50; trial++) {
      const rng = makeRng(1000 + trial);
      const poolSize = Math.floor(rng() * 25); // 0..24 (incl. empty pool)
      const rows = Array.from({ length: poolSize }, (_, i) => randomRow(rng, trial * 100 + i));
      const job = randomJob(rng, trial);
      const { svc, emittedCount } = makeSvc(rows, [job]);

      const res = await svc.applicantsForJob(job.jobId, CTX as never);
      // Structural: no relevance filter, so out == in, ALWAYS.
      expect(res.applicants.length).toBe(rows.length);
      expect(emittedCount()).toBe(rows.length);
      // Ranks are 1..n contiguous (ordering, not membership).
      expect(res.applicants.map((a) => a.rank)).toEqual(rows.map((_, i) => i + 1));
    }
  });

  it("View B: feed length == candidate-job count across 50 random job-sets", async () => {
    for (let trial = 0; trial < 50; trial++) {
      const rng = makeRng(9000 + trial);
      const jobCount = 1 + Math.floor(rng() * 12); // 1..12
      const jobs = Array.from({ length: jobCount }, (_, i) => randomJob(rng, trial * 100 + i));
      const worker = randomRow(rng, trial);
      const { svc, emittedCount } = makeSvc([worker], jobs);

      const res = await svc.feedForWorker(worker.workerId, CTX as never);
      expect(res.feed.length).toBe(jobs.length);
      expect(emittedCount()).toBe(jobs.length);
      expect(res.feed.map((f) => f.rank)).toEqual(jobs.map((_, i) => i + 1));
    }
  });
});

// ---------------------------------------------------------------------------
// D5 contract test — the DEFERRED application.* payloads stay compatible with a
// feed.shown-shaped {worker_id, job_id, rank} tuple. Pure schema test, no endpoint.
// ---------------------------------------------------------------------------
describe("D5 — application.* payloads accept a feed.shown-shaped tuple", () => {
  const tuple = {
    worker_id: "11111111-1111-4111-8111-111111111111",
    job_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    rank: 3,
  };

  it("the feed.shown shape itself validates (sanity)", () => {
    expect(FeedShownPayload.safeParse({ ...tuple, score: 0.5, hot: true }).success).toBe(true);
  });

  it("ApplicationSubmittedPayload accepts the {worker_id, job_id, rank} tuple", () => {
    const parsed = ApplicationSubmittedPayload.safeParse(tuple);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.worker_id).toBe(tuple.worker_id);
      expect(parsed.data.job_id).toBe(tuple.job_id);
      expect(parsed.data.rank).toBe(tuple.rank);
      // The deferred contract defaults the producer-supplied surface.
      expect(parsed.data.source_surface).toBe("feed");
    }
  });

  it("ApplicationSkippedPayload accepts the {worker_id, job_id} from the tuple", () => {
    // skip carries no rank; it must still accept the worker/job identity pair.
    const parsed = ApplicationSkippedPayload.safeParse({
      worker_id: tuple.worker_id,
      job_id: tuple.job_id,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reason).toBe("other");
  });
});

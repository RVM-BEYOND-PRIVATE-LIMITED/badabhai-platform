import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AiJobsRetentionSweepProcessor } from "./ai-jobs-retention-sweep.processor";
import type { AiJobsRepository } from "./ai-jobs.repository";

const DAY_MS = 86_400_000;

const OLD_COMPLETED = "aaaaaaaa-1111-4111-8111-111111111111";
const OLD_FAILED = "bbbbbbbb-2222-4222-8222-222222222222";
const OLD_QUEUED = "cccccccc-3333-4333-8333-333333333333";
const OLD_RUNNING = "dddddddd-4444-4444-8444-444444444444";
const OLD_REFERENCED = "eeeeeeee-5555-4555-8555-555555555555";
const YOUNG_COMPLETED = "ffffffff-6666-4666-8666-666666666666";

interface Row {
  id: string;
  jobType: string;
  status: string;
  updatedAt: Date;
  /** worker_profiles.ai_job_id points here (the TD14 tie → #420 landmine). */
  referenced: boolean;
}

const TERMINAL = new Set(["completed", "failed"]);

/**
 * In-memory double of ai_jobs. The repo mocks implement summarize/prune
 * faithfully against it, so these tests exercise the SWEEP's contract:
 * dry-run-by-default, armed-only deletion, window from config, bounded batch,
 * registration. NOTE the double restates the predicate's semantics by
 * construction — the predicate's own guarantees (strict cutoff, NOT EXISTS on
 * the TD14 tie, terminal-only) are enforced against the real SQL in
 * ai-jobs.repository.retention.test.ts, which is where the landmine test bites.
 */
function setup(
  rows: Row[] = [],
  opts: { windowDays?: number; intervalHours?: number; deleteEnabled?: boolean } = {},
) {
  const store = new Map<string, Row>(rows.map((r) => [r.id, r]));
  const isCandidate = (r: Row, cutoff: Date): boolean =>
    TERMINAL.has(r.status) && r.updatedAt.getTime() < cutoff.getTime() && !r.referenced;

  const aiJobs = {
    summarizeRetentionPrune: vi.fn(
      async (args: { cutoff: Date; cutoff2x: Date; cutoff4x: Date }) => {
        const all = [...store.values()];
        const candidates = all.filter((r) => isCandidate(r, args.cutoff));
        const skippedReferenced = all.filter(
          (r) =>
            TERMINAL.has(r.status) &&
            r.updatedAt.getTime() < args.cutoff.getTime() &&
            r.referenced,
        ).length;
        const byType: Record<string, number> = {};
        for (const r of candidates) byType[r.jobType] = (byType[r.jobType] ?? 0) + 1;
        const upTo2x = candidates.filter(
          (r) => r.updatedAt.getTime() >= args.cutoff2x.getTime(),
        ).length;
        const upTo4x = candidates.filter(
          (r) =>
            r.updatedAt.getTime() < args.cutoff2x.getTime() &&
            r.updatedAt.getTime() >= args.cutoff4x.getTime(),
        ).length;
        return {
          candidates: candidates.length,
          skippedReferenced,
          byType,
          ageDistribution: { upTo2x, upTo4x, over4x: candidates.length - upTo2x - upTo4x },
        };
      },
    ),
    pruneRetentionBatch: vi.fn(async (cutoff: Date, limit: number) => {
      const batch = [...store.values()]
        .filter((r) => isCandidate(r, cutoff))
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, limit);
      for (const r of batch) store.delete(r.id);
      return batch.length;
    }),
  };
  const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
  const config = {
    AI_JOBS_RETENTION_DAYS: opts.windowDays ?? 90,
    AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS: opts.intervalHours ?? 24,
    AI_JOBS_RETENTION_DELETE_ENABLED: opts.deleteEnabled ?? false,
  } as ServerConfig;

  const proc = new AiJobsRetentionSweepProcessor(
    aiJobs as unknown as AiJobsRepository,
    queue as unknown as Queue,
    config,
  );
  return { proc, store, aiJobs, queue };
}

/** The standard fixture: one of every interesting row, all relative to `now`. */
function fixtureRows(now: number): Row[] {
  return [
    { id: OLD_COMPLETED, jobType: "profile_extraction", status: "completed", updatedAt: new Date(now - 91 * DAY_MS), referenced: false },
    { id: OLD_FAILED, jobType: "transcription", status: "failed", updatedAt: new Date(now - 200 * DAY_MS), referenced: false },
    { id: OLD_QUEUED, jobType: "profile_extraction", status: "queued", updatedAt: new Date(now - 400 * DAY_MS), referenced: false },
    { id: OLD_RUNNING, jobType: "transcription", status: "running", updatedAt: new Date(now - 400 * DAY_MS), referenced: false },
    // THE LANDMINE row: completed, WAY past the window, but a worker_profiles
    // row references it (the #420 dedupe source). Must never be pruned.
    { id: OLD_REFERENCED, jobType: "profile_extraction", status: "completed", updatedAt: new Date(now - 400 * DAY_MS), referenced: true },
    { id: YOUNG_COMPLETED, jobType: "profile_extraction", status: "completed", updatedAt: new Date(now - 10 * DAY_MS), referenced: false },
  ];
}

describe("AiJobsRetentionSweepProcessor (PERF-3 — dry-run by default)", () => {
  it("DRY-RUN (the shipped default): reports counts + age distribution and deletes NOTHING", async () => {
    const h = setup(fixtureRows(Date.now()));

    const result = await h.proc.process();

    expect(result.dryRun).toBe(true);
    expect(result.pruned).toBe(0);
    expect(result.windowDays).toBe(90);
    // Candidates = old completed + old failed. Referenced/in-flight/young excluded.
    expect(result.candidates).toBe(2);
    expect(result.skippedReferenced).toBe(1);
    expect(result.byType).toEqual({ profile_extraction: 1, transcription: 1 });
    // 91d → ≤2x window; 200d → 2–4x window.
    expect(result.ageDistribution).toEqual({ upTo2x: 1, upTo4x: 1, over4x: 0 });
    // The hard guarantee: nothing was deleted, and the delete path never ran.
    expect(h.aiJobs.pruneRetentionBatch).not.toHaveBeenCalled();
    expect(h.store.size).toBe(6);
  });

  it("dry-run logs counts only — never a job id, never PII", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const h = setup(fixtureRows(Date.now()));
      await h.proc.process();
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("DRY-RUN");
      expect(logged).toContain("candidates=2");
      expect(logged).toContain("skipped_referenced=1");
      expect(logged).toContain("window_days=90");
      for (const id of h.store.keys()) expect(logged).not.toContain(id);
      expect(logged).not.toMatch(/\+91|phone|full_?name/i);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("ARMED prunes terminal-and-old rows — and ONLY those", async () => {
    const h = setup(fixtureRows(Date.now()), { deleteEnabled: true });

    const result = await h.proc.process();

    expect(result.dryRun).toBe(false);
    expect(result.pruned).toBe(2);
    expect(h.store.has(OLD_COMPLETED)).toBe(false);
    expect(h.store.has(OLD_FAILED)).toBe(false);
    // queued/running survive at ANY age (retention never touches in-flight rows)…
    expect(h.store.has(OLD_QUEUED)).toBe(true);
    expect(h.store.has(OLD_RUNNING)).toBe(true);
    // …the REFERENCED completed row survives (the #420 landmine)…
    expect(h.store.has(OLD_REFERENCED)).toBe(true);
    // …and younger-than-window rows survive.
    expect(h.store.has(YOUNG_COMPLETED)).toBe(true);
  });

  it("armed mode passes the SAME cutoff to the summary and the delete, with the batch bound", async () => {
    const h = setup(fixtureRows(Date.now()), { deleteEnabled: true });
    await h.proc.process();
    const summarizeArgs = h.aiJobs.summarizeRetentionPrune.mock.calls[0]![0];
    const [pruneCutoff, limit] = h.aiJobs.pruneRetentionBatch.mock.calls[0]!;
    expect(pruneCutoff).toEqual(summarizeArgs.cutoff);
    expect(limit).toBe(1000);
  });

  it("reads the window from config: AI_JOBS_RETENTION_DAYS drives the cutoff (and the 2x/4x buckets)", async () => {
    const before = Date.now();
    const h = setup([], { windowDays: 30 });
    const result = await h.proc.process();
    const after = Date.now();

    expect(result.windowDays).toBe(30);
    const args = h.aiJobs.summarizeRetentionPrune.mock.calls[0]![0];
    expect(args.cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * DAY_MS);
    expect(args.cutoff.getTime()).toBeLessThanOrEqual(after - 30 * DAY_MS);
    expect(args.cutoff2x.getTime()).toBeGreaterThanOrEqual(before - 60 * DAY_MS);
    expect(args.cutoff2x.getTime()).toBeLessThanOrEqual(after - 60 * DAY_MS);
    expect(args.cutoff4x.getTime()).toBeGreaterThanOrEqual(before - 120 * DAY_MS);
    expect(args.cutoff4x.getTime()).toBeLessThanOrEqual(after - 120 * DAY_MS);
  });

  it("a narrower window prunes the previously-young row; a wider one spares the previously-old", async () => {
    const now = Date.now();
    // 10-day-old completed row: pruned under a 7-day window…
    const narrow = setup(fixtureRows(now), { windowDays: 7, deleteEnabled: true });
    await narrow.proc.process();
    expect(narrow.store.has(YOUNG_COMPLETED)).toBe(false);
    // …and the 91-day-old row survives under a 365-day window.
    const wide = setup(fixtureRows(now), { windowDays: 365, deleteEnabled: true });
    await wide.proc.process();
    expect(wide.store.has(OLD_COMPLETED)).toBe(true);
  });

  it("is idempotent across armed runs: a second tick finds nothing left to prune", async () => {
    const h = setup(fixtureRows(Date.now()), { deleteEnabled: true });
    const first = await h.proc.process();
    const second = await h.proc.process();
    expect(first.pruned).toBe(2);
    expect(second.pruned).toBe(0);
  });

  it("onApplicationBootstrap registers the repeatable sweep via upsertJobScheduler (idempotent id)", async () => {
    const h = setup([], { intervalHours: 24 });
    await h.proc.onApplicationBootstrap();
    expect(h.queue.upsertJobScheduler).toHaveBeenCalledWith("ai-jobs-retention-sweep", {
      every: 86_400_000,
    });
  });

  it("honors a fractional AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS (tests/staging cadence)", async () => {
    const h = setup([], { intervalHours: 0.5 });
    await h.proc.onApplicationBootstrap();
    expect(h.queue.upsertJobScheduler).toHaveBeenCalledWith("ai-jobs-retention-sweep", {
      every: 1_800_000,
    });
  });

  it("a scheduler-registration failure is logged, never thrown (boot must not die on Redis)", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const h = setup();
      h.queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
      await expect(h.proc.onApplicationBootstrap()).resolves.toBeUndefined();
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/registration failed/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

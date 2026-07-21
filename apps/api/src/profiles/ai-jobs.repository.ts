import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { type Database, aiJobs, workerProfiles, type AiJob, type NewAiJob } from "@badabhai/db";
import type { AiJobStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { ProfileContentFields } from "./profile-content";

/**
 * A prior `profile_extraction` job for a session that MIGHT make a fresh
 * extraction redundant. Whether it actually does is decided by the caller —
 * for a `completed` job that depends on whether it produced a usable profile
 * (`hasExtractedContent`), which is domain logic, not data access.
 */
export interface ExtractionDedupeCandidate {
  id: string;
  status: AiJobStatus;
  /** The profile this job produced (`worker_profiles.ai_job_id`), if any. */
  profile: ProfileContentFields | null;
}

/** Non-terminal statuses: work that is supposedly still in flight. */
const IN_FLIGHT_STATUSES = ["queued", "running"] as const;

/** Terminal statuses: work that is finished for good (PERF-3 retention scope).
 * Deliberately the complement of IN_FLIGHT_STATUSES over the closed
 * @badabhai/types AI_JOB_STATUSES enum — retention may only ever see these two. */
const TERMINAL_STATUSES = ["completed", "failed"] as const;

/**
 * PERF-3 — "this terminal row is still load-bearing" (the landmine). A
 * `worker_profiles.ai_job_id` pointing at the row is a LOGICAL ref (no FK — the
 * TD14 unique-index tie), and the #420 dedupe (`findExtractionDedupeCandidate`
 * above) LEFT JOINs through it to find the prior COMPLETED extraction. Pruning a
 * referenced row would make that dedupe blind: the worker's next profile-preview
 * mount would fire a fresh extraction (real AI spend) on EVERY mount until a new
 * job completes — a slow re-opening of the exact bug #427/#430/#438/#467 closed.
 *
 * Written as a raw correlated subquery (not the `notExists(db.select…)` builder)
 * so the predicate stays a PURE function of the schema — no db handle needed —
 * and its AST stays interpretable by the behavioural test suite (the
 * ai-jobs.repository.test.ts pattern: evaluated, not just string-matched).
 */
const referencedByWorkerProfile = (): SQL =>
  sql`exists (select 1 from ${workerProfiles} where ${workerProfiles.aiJobId} = ${aiJobs.id})`;

/**
 * PERF-3 — the retention-prune predicate (OWNER DECISION 2026-07-21: terminal
 * rows older than 90 days). A row is prunable iff ALL of:
 *   1. status is TERMINAL (completed/failed) — queued/running rows are NEVER
 *      touched regardless of age (a zombie row is the #420 in-flight guard's
 *      problem, not retention's);
 *   2. `updated_at` (the terminal transition — never earlier than created_at, so
 *      the conservative reading of "older than N days") is STRICTLY before the
 *      cutoff;
 *   3. NO `worker_profiles.ai_job_id` references it (see
 *      `referencedByWorkerProfile` — the #420 dedupe landmine). Applied to EVERY
 *      job type, not just profile_extraction: today only extraction rows are ever
 *      referenced, but the guard must hold for any future writer of that column.
 *
 * Exported for the structural/behavioural repository tests; used by BOTH the
 * dry-run summary and the armed delete, so what the sweep reports and what it
 * would delete can never drift.
 */
export const retentionPruneWhere = (cutoff: Date): SQL =>
  and(
    inArray(aiJobs.status, [...TERMINAL_STATUSES]),
    lt(aiJobs.updatedAt, cutoff),
    sql`not ${referencedByWorkerProfile()}`,
  )!;

/** PII-free counts describing one retention-sweep evaluation (PERF-3). */
export interface RetentionPruneSummary {
  /** Prunable rows: terminal + aged-out + NOT referenced by worker_profiles. */
  candidates: number;
  /** Aged-out terminal rows KEPT because worker_profiles.ai_job_id references them. */
  skippedReferenced: number;
  /** Candidates by job type (counts only). */
  byType: Record<string, number>;
  /** Candidate age distribution in multiples of the retention window. */
  ageDistribution: { upTo2x: number; upTo4x: number; over4x: number };
}

/**
 * Operational AI usage/cost metadata persisted on an `ai_jobs` row when a job
 * completes. PII-free by construction — only these typed scalars (never prompts,
 * completions, transcripts, names, or phone numbers).
 */
export interface AiJobUsageMetadata {
  modelName: string | null;
  realCall: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costInr: number | null;
}

@Injectable()
export class AiJobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Most-recent AI jobs first, for the read-only ops console. */
  async list(limit = 100): Promise<AiJob[]> {
    return this.db.select().from(aiJobs).orderBy(desc(aiJobs.createdAt)).limit(limit);
  }

  async findById(id: string): Promise<AiJob | undefined> {
    const rows = await this.db.select().from(aiJobs).where(eq(aiJobs.id, id)).limit(1);
    return rows[0];
  }

  /**
   * Newest `profile_extraction` job for a session that could make a fresh
   * extraction redundant (issue #420), together with the profile it produced.
   *
   * Matches when the job is EITHER:
   *   - `queued`/`running` AND newer than `inFlightSince` — genuinely in flight; or
   *   - `completed` — succeeded, but the CALLER must still check the joined
   *     profile has content before deduping against it.
   *
   * Deliberate exclusions:
   *   - `failed` never matches → a failed extraction stays retryable.
   *   - stale `queued`/`running` never matches. There is no reaper for stuck
   *     ai_jobs, and `ProfilesService.extract` INSERTs `queued` BEFORE enqueueing:
   *     a crash in that window leaves a row that is never enqueued, so no BullMQ
   *     retry and no processor to fail it. Without the age bound such a zombie
   *     would be returned forever and the client would poll it to timeout on
   *     every attempt.
   *
   * SCOPING: `worker_id` is part of the predicate, not just `session_id`. The
   * controller takes `session_id` from the request body with no ownership check,
   * so without this another worker's job could permanently deduplicate — and thus
   * deny — the owner's own extraction. (The pre-existing transcript-read half of
   * that gap is untouched here; this only stops the denial from persisting.)
   *
   * Both predicates read opaque UUIDs out of `input_ref` — no PII crosses this
   * boundary (CLAUDE.md §2 invariant 2).
   */
  async findExtractionDedupeCandidate(args: {
    sessionId: string;
    workerId: string;
    inFlightSince: Date;
  }): Promise<ExtractionDedupeCandidate | undefined> {
    const rows = await this.db
      .select({
        id: aiJobs.id,
        status: aiJobs.status,
        canonicalTradeId: workerProfiles.canonicalTradeId,
        canonicalRoleId: workerProfiles.canonicalRoleId,
        skills: workerProfiles.skills,
        machines: workerProfiles.machines,
        experience: workerProfiles.experience,
        salaryExpectation: workerProfiles.salaryExpectation,
        locationPreference: workerProfiles.locationPreference,
        availability: workerProfiles.availability,
        richProfileDraft: workerProfiles.richProfileDraft,
        profileId: workerProfiles.id,
      })
      .from(aiJobs)
      .leftJoin(workerProfiles, eq(workerProfiles.aiJobId, aiJobs.id))
      .where(
        and(
          eq(aiJobs.jobType, "profile_extraction"),
          sql`${aiJobs.inputRef}->>'session_id' = ${args.sessionId}`,
          sql`${aiJobs.inputRef}->>'worker_id' = ${args.workerId}`,
          or(
            and(
              inArray(aiJobs.status, [...IN_FLIGHT_STATUSES]),
              gt(aiJobs.createdAt, args.inFlightSince),
            ),
            eq(aiJobs.status, "completed"),
          ),
        ),
      )
      .orderBy(desc(aiJobs.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      profile:
        row.profileId == null
          ? null
          : {
              canonicalTradeId: row.canonicalTradeId,
              canonicalRoleId: row.canonicalRoleId,
              skills: row.skills,
              machines: row.machines,
              experience: row.experience,
              salaryExpectation: row.salaryExpectation,
              locationPreference: row.locationPreference,
              availability: row.availability,
              richProfileDraft: row.richProfileDraft,
            },
    };
  }

  async create(input: NewAiJob): Promise<AiJob> {
    const inserted = await this.db.insert(aiJobs).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create AI job");
    return row;
  }

  async markRunning(id: string): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }

  async markCompleted(
    id: string,
    outputRef: Record<string, unknown>,
    usage?: AiJobUsageMetadata,
  ): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "completed", outputRef, ...(usage ?? {}), updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "failed", errorMessage, updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }

  /**
   * PERF-3 — one PII-free summary of what the retention sweep WOULD prune (and
   * what it deliberately keeps). Runs on every tick: it IS the dry-run output,
   * and in armed mode it is logged alongside the delete so the two modes report
   * identically. Counts only — job ids never leave this method, and no PII exists
   * on the table to begin with (§2 invariant 2).
   *
   * `cutoff2x`/`cutoff4x` bucket the CANDIDATES by age in multiples of the
   * retention window (1–2x, 2–4x, >4x) — the age distribution the dry-run
   * requirement asks for, computed in one grouped pass with FILTER clauses.
   */
  async summarizeRetentionPrune(args: {
    cutoff: Date;
    cutoff2x: Date;
    cutoff4x: Date;
  }): Promise<RetentionPruneSummary> {
    const rows = await this.db
      .select({
        jobType: aiJobs.jobType,
        total: sql<number>`count(*)::int`,
        upTo2x: sql<number>`count(*) filter (where ${aiJobs.updatedAt} >= ${args.cutoff2x})::int`,
        upTo4x: sql<number>`count(*) filter (where ${aiJobs.updatedAt} < ${args.cutoff2x} and ${aiJobs.updatedAt} >= ${args.cutoff4x})::int`,
      })
      .from(aiJobs)
      .where(retentionPruneWhere(args.cutoff))
      .groupBy(aiJobs.jobType);

    // The landmine's other half: aged-out terminal rows KEPT because a
    // worker_profiles row still points at them. Counted (not silently absorbed)
    // so ops can see the #420-protection working — and notice if it ever balloons.
    const skipped = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiJobs)
      .where(
        and(
          inArray(aiJobs.status, [...TERMINAL_STATUSES]),
          lt(aiJobs.updatedAt, args.cutoff),
          referencedByWorkerProfile(),
        ),
      );

    const summary: RetentionPruneSummary = {
      candidates: 0,
      skippedReferenced: skipped[0]?.n ?? 0,
      byType: {},
      ageDistribution: { upTo2x: 0, upTo4x: 0, over4x: 0 },
    };
    for (const row of rows) {
      summary.candidates += row.total;
      summary.byType[row.jobType] = row.total;
      summary.ageDistribution.upTo2x += row.upTo2x;
      summary.ageDistribution.upTo4x += row.upTo4x;
      summary.ageDistribution.over4x += row.total - row.upTo2x - row.upTo4x;
    }
    return summary;
  }

  /**
   * PERF-3 — one bounded, ARMED prune batch. Deletes at most `limit` rows per
   * call (oldest terminal first, so a pathological backlog drains deterministically
   * across ticks — the SWEEP_BATCH_LIMIT posture of the deletion sweep).
   *
   * The DELETE re-applies the FULL prune predicate on top of the id batch. Review
   * note (PR #481, both verify lenses): the safety mechanism here is NOT a
   * select-then-delete re-check — the batch SELECT is an un-executed builder
   * embedded as a subquery, so SELECT and DELETE run as ONE statement under one
   * snapshot, and under READ COMMITTED the NOT EXISTS leg would NOT see a
   * concurrently-committed `worker_profiles` insert on its own. What actually
   * protects a concurrently-referenced job is WRITE ORDERING: every writer of
   * `worker_profiles.ai_job_id` (profile-extraction.processor.ts) first flips the
   * SAME ai_jobs row via markRunning, and Postgres's EvalPlanQual re-evaluates the
   * re-applied predicate on that modified row version — which then fails the
   * terminal+aged legs before any reference can appear. If a future writer ever
   * references a job WITHOUT first updating that ai_jobs row, this protection does
   * not hold mid-statement — keep the markRunning-first ordering. Returns the
   * count actually deleted.
   */
  async pruneRetentionBatch(cutoff: Date, limit: number): Promise<number> {
    const batch = this.db
      .select({ id: aiJobs.id })
      .from(aiJobs)
      .where(retentionPruneWhere(cutoff))
      .orderBy(asc(aiJobs.updatedAt))
      .limit(limit);
    const deleted = await this.db
      .delete(aiJobs)
      .where(and(inArray(aiJobs.id, batch), retentionPruneWhere(cutoff)))
      .returning({ id: aiJobs.id });
    return deleted.length;
  }
}

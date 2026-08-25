import { Inject, Injectable } from "@nestjs/common";
import { and, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { jobPostings, jobReachWiden } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * One due widen grant: a widen request whose expiry has passed and which the sweep has
 * not yet processed. `id` is stable across retries, so it can key the retraction event's
 * idempotency without a second round-trip.
 */
export interface DueWidenRow {
  id: string;
  jobPostingId: string;
  addedSkillIds: string[];
  opsActorId: string;
}

/**
 * Data access for `job_reach_widen` (migration 0090) — Policy 27's expiry half.
 *
 * Pure data access only: the retract DECISION (what stays protected, when to
 * re-materialize, what to emit) lives in PublishReachService.retractExpiredWidens.
 * This class never writes `job_postings` or `job_reach` itself.
 */
@Injectable()
export class ReachWidenRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Record one widen request's expiry (Policy 27 "expiring"). Written AFTER the reach
   * write commits: a widen whose provenance insert failed simply never expires — the
   * pre-0090 posture — which fails safe toward more reach, never less.
   */
  async insertGrant(input: {
    jobPostingId: string;
    addedSkillIds: readonly string[];
    expiresAt: Date;
    opsActorId: string;
  }): Promise<void> {
    await this.db.insert(jobReachWiden).values({
      jobPostingId: input.jobPostingId,
      addedSkillIds: [...input.addedSkillIds],
      expiresAt: input.expiresAt,
      opsActorId: input.opsActorId,
    });
  }

  /**
   * The sweep's work list: un-retracted grants past their expiry, oldest first, bounded
   * per tick (a backlog drains across ticks; the partial index `job_reach_widen_due_idx`
   * makes the probe cheap at steady state).
   */
  async findDueBatch(limit: number): Promise<DueWidenRow[]> {
    const rows = await this.db
      .select({
        id: jobReachWiden.id,
        jobPostingId: jobReachWiden.jobPostingId,
        addedSkillIds: jobReachWiden.addedSkillIds,
        opsActorId: jobReachWiden.opsActorId,
      })
      .from(jobReachWiden)
      .where(and(isNull(jobReachWiden.retractedAt), lte(jobReachWiden.expiresAt, sql`now()`)))
      .orderBy(jobReachWiden.expiresAt)
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      jobPostingId: r.jobPostingId,
      addedSkillIds: Array.isArray(r.addedSkillIds) ? r.addedSkillIds : [],
      opsActorId: r.opsActorId,
    }));
  }

  /**
   * Count of due grants — the DRY-RUN report. Counts only; the processor logs this
   * while disarmed and no id ever reaches a log line.
   */
  async countDue(): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobReachWiden)
      .where(and(isNull(jobReachWiden.retractedAt), lte(jobReachWiden.expiresAt, sql`now()`)));
    return rows[0]?.n ?? 0;
  }

  /**
   * Ids from OTHER, still-active widen rows on these postings — the protection set that
   * stops an old expired row from retracting a skill a NEWER widen legitimately granted.
   * The current batch's own rows are excluded by id, or they would protect themselves
   * and nothing would ever be retracted. Posted skills are protected separately by the
   * service (they come from `match_skill_ids`, not from any widen row).
   */
  async activeIdsForPostings(
    jobPostingIds: readonly string[],
    excludeRowIds: readonly string[],
  ): Promise<Set<string>> {
    if (jobPostingIds.length === 0) return new Set();
    const conditions = [
      inArray(jobReachWiden.jobPostingId, [...jobPostingIds]),
      isNull(jobReachWiden.retractedAt),
    ];
    if (excludeRowIds.length > 0) {
      conditions.push(notInArray(jobReachWiden.id, [...excludeRowIds]));
    }
    const rows = await this.db
      .select({ addedSkillIds: jobReachWiden.addedSkillIds })
      .from(jobReachWiden)
      .where(and(...conditions));
    const out = new Set<string>();
    for (const r of rows) {
      if (Array.isArray(r.addedSkillIds)) for (const id of r.addedSkillIds) out.add(id);
    }
    return out;
  }

  /**
   * Posting lifecycle state for the retract decision. Only live postings
   * (`open`/`paused`) are worth re-materializing; anything else just gets its
   * provenance stamped — a draft/closed/suspended posting's sets are rebuilt or
   * irrelevant on its next transition anyway.
   */
  async statusForPostings(
    jobPostingIds: readonly string[],
  ): Promise<Map<string, JobPostingStatusRow>> {
    if (jobPostingIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: jobPostings.id, status: jobPostings.status })
      .from(jobPostings)
      .where(inArray(jobPostings.id, [...jobPostingIds]));
    return new Map(rows.map((r) => [r.id, { status: r.status }]));
  }

  /**
   * Stamp the batch as processed. Idempotent by construction: the predicate targets
   * exactly the rows the tick read, and a retried tick finds nothing left.
   */
  async markRetracted(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(jobReachWiden)
      .set({ retractedAt: sql`now()` })
      .where(inArray(jobReachWiden.id, [...ids]));
  }
}

export interface JobPostingStatusRow {
  status: string;
}

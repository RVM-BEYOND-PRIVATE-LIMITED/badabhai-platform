import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  RVM_INSTITUTE_CODE,
  auditLogs,
  jobPostingInstituteReviews,
  jobPostings,
  postingReviewContentHash,
  rvmReviewStateNow,
  type Database,
  type InstituteReviewState,
  type JobPostingAudience,
} from "@badabhai/db";
import type { JobPostingStatus } from "@badabhai/types";
import { redactQueryParams } from "../common/db-error";
import { DATABASE } from "../database/database.module";

/** A posting as the review decides on it. */
export interface ReviewTarget {
  id: string;
  /**
   * `job_postings.payer_id` as stored: the owning company's tenant key, `null` for an ops posting
   * or an agency twin. Never compared with anything a caller sent.
   */
  ownerPayerId: string | null;
  status: JobPostingStatus;
  hidden: boolean;
  audience: JobPostingAudience;
  rvmBranchIds: number[];
  rvmCourseIds: string[];
}

/** The posting under the decision's `FOR SHARE` lock, with its content hash computed there. */
export interface LockedReviewTarget extends ReviewTarget {
  /** `postingReviewContentHash` of the row as locked. */
  contentHash: string;
}

/** The decision columns one write stores, as the service canonicalised them. */
export interface DecisionWrite {
  jobPostingId: string;
  state: "approved" | "rejected";
  reviewerRef: string;
  reason: string | null;
  branchIds: number[] | null;
  courseIds: string[] | null;
  /** The hash the reviewer saw. Nothing is written unless it is the posting's hash now. */
  expectedContentHash: string;
  /** Campus's `decided_at`: stored as `reviewed_at`, and what orders two decisions. */
  decidedAt: string;
}

/**
 * Where a decision's `decided_at` stands against the decision the row holds:
 *   - `none`: the row holds no decision (`pending`), so any time applies;
 *   - `newer` / `same` / `older`: compared with the held `reviewed_at`, in Postgres, to the
 *     microsecond.
 */
export type DecisionTiming = "none" | "newer" | "same" | "older";

/** The posting's RVM review row, locked `FOR UPDATE` by {@link CampusPostingReviewRepository.lockReview}. */
export interface LockedReview {
  state: InstituteReviewState;
  timing: DecisionTiming;
  /** Every decision column equal to the incoming decision's (state, reviewer, reason, narrowing, hash). */
  sameDecision: boolean;
}

/** What {@link CampusPostingReviewRepository.writeDecision}'s one statement did. */
export type DecisionWriteResult =
  | { outcome: "written"; contentHash: string }
  /** The posting's hash is not `expectedContentHash`: nothing was written. */
  | { outcome: "posting_changed"; contentHash: string }
  /** The row holds a decision at or after `decidedAt`: nothing was written. */
  | { outcome: "not_applied"; contentHash: string }
  | { outcome: "missing" };

/** The decision's own `audit_logs` row (the guard wrote the per-call row already). */
export interface ReviewAudit {
  jobPostingId: string;
  reviewerRef: string;
  metadata: Record<string, unknown>;
}

/** `audit_logs.action` of a Campus review decision. */
export const CAMPUS_REVIEW_AUDIT_ACTION = "campus_link.posting_reviewed";

/** `audit_logs.actor_type` of a decision: a Campus placement-team member, by reference. */
export const CAMPUS_STAFF_ACTOR_TYPE = "campus_staff";

/** The narrowed lists as jsonb text, or SQL NULL for "not narrowed". */
function jsonOrNull(list: readonly (number | string)[] | null): string | null {
  return list === null ? null : JSON.stringify(list);
}

/**
 * #2746 PR 5 — THE PLACEMENT TEAM'S DECISION on the RVM part of a posting, as Campus records it
 * (`PUT job-postings/:id/review`). DATABASE ACCESS ONLY: which postings may be reviewed, the
 * ordering rules, the narrowing rules and the events are `CampusPostingReviewService`'s.
 *
 * LOCK ORDER — THE HOUSE RULE (`@badabhai/db` `job-review.ts`): the POSTING row first, then the
 * REVIEW row. A decision takes the posting `FOR SHARE` ({@link lockTarget}), then makes sure the
 * review row exists and takes it `FOR UPDATE` ({@link lockReview}), then writes it
 * ({@link writeDecision}). PR 4's company edit takes the posting with `FOR NO KEY UPDATE` and its
 * UPDATE, and only then opens, resets or bumps the review row. Same order, so the two wait for each
 * other and never deadlock; and `FOR SHARE` conflicts with both of the company's row locks, so no
 * edit can commit between the decision's hash read and its write. Two decisions share the posting
 * lock and serialise on the review row.
 *
 * ONE CLOCK FOR `updated_at`. Every review-row write here stamps `updated_at = clock_timestamp()`
 * (the moment of the write, not the transaction's start), as PR 4's writes do; Campus's feed
 * reads that column. `reviewed_at` is Campus's `decided_at`, its own clock, and orders decisions.
 *
 * THE HASH IS SQL'S. `postingReviewContentHash` runs inside the locked read and again inside the
 * write statement, which stores what it computed and only when that equals the hash the reviewer
 * saw. TypeScript never computes or forwards a hash to be stored.
 *
 * Statements that bind the reason or the narrowing rethrow a database error through
 * `redactQueryParams`, so a failure log carries the SQL text and the code, never the note.
 */
@Injectable()
export class CampusPostingReviewRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` in ONE transaction: the review row, its event and its audit row commit together. */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** The posting by id, unlocked: the cheap pre-check before any transaction is opened. */
  async findTarget(id: string): Promise<ReviewTarget | undefined> {
    const rows = await this.db
      .select(this.targetColumns())
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1);
    return rows[0];
  }

  /**
   * The posting under `SELECT … FOR SHARE`, with its content hash computed in the same statement.
   * Held to the end of the caller's transaction.
   */
  async lockTarget(id: string, tx: Database): Promise<LockedReviewTarget | undefined> {
    const rows = await tx
      .select({
        ...this.targetColumns(),
        contentHash: sql<string>`${postingReviewContentHash()}`,
      })
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1)
      .for("share");
    return rows[0];
  }

  /**
   * The RVM review row under `FOR UPDATE`, taken AFTER the posting ({@link lockTarget}), with how
   * `decision` stands against the decision it holds. A posting with no row gets a `pending` one
   * first (`jpir_decision_chk`'s pending shape), so a first decision has a row to lock and a
   * `previous_state` to report, and two first decisions serialise instead of racing an insert.
   *
   * The `SELECT … FOR UPDATE` runs BEFORE any insert: when the row exists, a second decision queues
   * on the row lock itself and reads the committed row once it is granted. Only when it is absent
   * does `INSERT … ON CONFLICT DO NOTHING` run (a concurrent first insert makes it wait for that
   * transaction), followed by the same `SELECT … FOR UPDATE`. The statement reads plain columns
   * only: a subquery here would see the statement's snapshot, not the row version the lock granted.
   */
  async lockReview(tx: Database, decision: DecisionWrite): Promise<LockedReview> {
    try {
      const held = await this.selectReviewForUpdate(tx, decision);
      if (held !== undefined) return held;
      await tx
        .insert(jobPostingInstituteReviews)
        .values({
          jobPostingId: decision.jobPostingId,
          instituteCode: RVM_INSTITUTE_CODE,
          state: "pending",
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing();
      const created = await this.selectReviewForUpdate(tx, decision);
      // The posting is locked FOR SHARE, so nothing can cascade the row away in between.
      if (created === undefined) throw new Error("campus review: review row missing after insert");
      return created;
    } catch (err) {
      throw redactQueryParams(err, "campus review row lock");
    }
  }

  /**
   * The review state a reader saw before this decision (the live-hash rule), in its OWN statement,
   * read after {@link lockReview}: a fresh snapshot, so it sees the decision that held the row lock
   * before us.
   */
  async reviewStateNow(id: string, tx: Database): Promise<InstituteReviewState> {
    const rows = await tx
      .select({ stateNow: sql<InstituteReviewState>`${rvmReviewStateNow()}` })
      .from(jobPostingInstituteReviews)
      .innerJoin(jobPostings, eq(jobPostings.id, jobPostingInstituteReviews.jobPostingId))
      .where(
        and(
          eq(jobPostingInstituteReviews.jobPostingId, id),
          eq(jobPostingInstituteReviews.instituteCode, RVM_INSTITUTE_CODE),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error("campus review: review row missing under its lock");
    return row.stateNow;
  }

  /**
   * THE DECISION, ONE STATEMENT. `target` computes the posting's hash; the upsert replaces every
   * decision column only when that hash equals `expectedContentHash` (storing the hash it
   * computed) AND the row holds no decision or an older one (`reviewed_at < decided_at`). The
   * service has already decided both under the same locks; this statement holds the same line on
   * its own, so no caller can store a stale decision by skipping a check.
   */
  async writeDecision(tx: Database, input: DecisionWrite): Promise<DecisionWriteResult> {
    let rows: { content_hash: string; written: boolean }[];
    try {
      rows = (await tx.execute(sql`
        WITH "target" AS (
          SELECT "jp"."id" AS "id", ${postingReviewContentHash("jp")} AS "content_hash"
            FROM ${jobPostings} AS "jp"
           WHERE "jp"."id" = ${input.jobPostingId}::uuid
        ), "written" AS (
          INSERT INTO ${jobPostingInstituteReviews} AS "r"
            ("job_posting_id", "institute_code", "state", "reviewer_ref", "reviewed_at", "reason",
             "branch_ids", "course_ids", "content_hash", "updated_at")
          SELECT "t"."id", ${RVM_INSTITUTE_CODE}::text, ${input.state}::text,
                 ${input.reviewerRef}::text, ${input.decidedAt}::timestamptz, ${input.reason}::text,
                 ${jsonOrNull(input.branchIds)}::jsonb, ${jsonOrNull(input.courseIds)}::jsonb,
                 "t"."content_hash", clock_timestamp()
            FROM "target" AS "t"
           WHERE "t"."content_hash" = ${input.expectedContentHash}::text
          ON CONFLICT ("job_posting_id", "institute_code") DO UPDATE SET
            "state" = EXCLUDED."state",
            "reviewer_ref" = EXCLUDED."reviewer_ref",
            "reviewed_at" = EXCLUDED."reviewed_at",
            "reason" = EXCLUDED."reason",
            "branch_ids" = EXCLUDED."branch_ids",
            "course_ids" = EXCLUDED."course_ids",
            "content_hash" = EXCLUDED."content_hash",
            "updated_at" = EXCLUDED."updated_at"
          WHERE "r"."state" = 'pending' OR "r"."reviewed_at" < EXCLUDED."reviewed_at"
          RETURNING "r"."job_posting_id"
        )
        SELECT "t"."content_hash" AS "content_hash",
               EXISTS (SELECT 1 FROM "written") AS "written"
          FROM "target" AS "t"
      `)) as unknown as { content_hash: string; written: boolean }[];
    } catch (err) {
      throw redactQueryParams(err, "campus review decision write");
    }

    const row = rows[0];
    if (row === undefined) return { outcome: "missing" };
    if (row.content_hash !== input.expectedContentHash) {
      return { outcome: "posting_changed", contentHash: row.content_hash };
    }
    return row.written
      ? { outcome: "written", contentHash: row.content_hash }
      : { outcome: "not_applied", contentHash: row.content_hash };
  }

  /** The decision's `audit_logs` row, on the decision's transaction. Ids, enums and counts only. */
  async writeAudit(tx: Database, audit: ReviewAudit): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: CAMPUS_STAFF_ACTOR_TYPE,
      actorId: audit.reviewerRef,
      action: CAMPUS_REVIEW_AUDIT_ACTION,
      entityType: "job_posting",
      entityId: audit.jobPostingId,
      metadata: audit.metadata,
    });
  }

  /** The row `FOR UPDATE`, compared with `decision` in Postgres (time to the microsecond). */
  private async selectReviewForUpdate(
    tx: Database,
    decision: DecisionWrite,
  ): Promise<LockedReview | undefined> {
    const rows = (await tx.execute(sql`
      SELECT "r"."state" AS "state",
             CASE WHEN "r"."state" = 'pending' OR "r"."reviewed_at" IS NULL THEN 'none'
                  WHEN ${decision.decidedAt}::timestamptz > "r"."reviewed_at" THEN 'newer'
                  WHEN ${decision.decidedAt}::timestamptz = "r"."reviewed_at" THEN 'same'
                  ELSE 'older' END AS "timing",
             (("r"."state", "r"."reviewer_ref", "r"."reason", "r"."branch_ids", "r"."course_ids",
               "r"."content_hash")
               IS NOT DISTINCT FROM (${decision.state}::text, ${decision.reviewerRef}::text,
                 ${decision.reason}::text, ${jsonOrNull(decision.branchIds)}::jsonb,
                 ${jsonOrNull(decision.courseIds)}::jsonb,
                 ${decision.expectedContentHash}::text)) AS "same_decision"
        FROM ${jobPostingInstituteReviews} AS "r"
       WHERE "r"."job_posting_id" = ${decision.jobPostingId}::uuid
         AND "r"."institute_code" = ${RVM_INSTITUTE_CODE}::text
         FOR UPDATE`)) as unknown as {
      state: InstituteReviewState;
      timing: DecisionTiming;
      same_decision: boolean;
    }[];
    const row = rows[0];
    return row === undefined
      ? undefined
      : { state: row.state, timing: row.timing, sameDecision: row.same_decision };
  }

  private targetColumns() {
    return {
      id: jobPostings.id,
      ownerPayerId: jobPostings.payerId,
      status: jobPostings.status,
      hidden: sql<boolean>`(${jobPostings.hiddenAt} IS NOT NULL)`,
      audience: jobPostings.audience,
      rvmBranchIds: jobPostings.rvmBranchIds,
      rvmCourseIds: jobPostings.rvmCourseIds,
    };
  }
}

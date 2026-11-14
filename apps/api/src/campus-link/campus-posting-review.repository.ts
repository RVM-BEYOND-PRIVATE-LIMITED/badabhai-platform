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

/** The posting's RVM review row before the decision, under `FOR UPDATE`. */
export interface ReviewBefore {
  state: InstituteReviewState;
  /** The state a reader saw (the live-hash rule: a decision on older content reads `pending`). */
  stateNow: InstituteReviewState;
  reviewedAt: Date | null;
}

/** The decision columns one write stores. */
export interface DecisionWrite {
  jobPostingId: string;
  state: "approved" | "rejected";
  reviewerRef: string;
  reason: string | null;
  branchIds: number[] | null;
  courseIds: string[] | null;
  /** The hash the reviewer saw. Nothing is written unless it is the posting's hash now. */
  expectedContentHash: string;
}

/** What {@link CampusPostingReviewRepository.writeDecision}'s one statement did. */
export type DecisionWriteResult =
  | { outcome: "written"; contentHash: string; reviewedAt: Date }
  /** The row already held exactly this decision on this content: nothing was written. */
  | { outcome: "unchanged"; contentHash: string }
  /** The posting's hash is not `expectedContentHash`: nothing was written. */
  | { outcome: "posting_changed"; contentHash: string }
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
 * narrowing rules and the events are `CampusPostingReviewService`'s.
 *
 * LOCK ORDER — THE HOUSE RULE (`@badabhai/db` `job-review.ts`): the POSTING row first, then the
 * REVIEW row. A decision takes the posting `FOR SHARE` ({@link lockTarget}), then the review row
 * `FOR UPDATE` ({@link lockReviewBefore}), then writes it ({@link writeDecision}). PR 4's company
 * edit takes the posting with `FOR NO KEY UPDATE` and its UPDATE, and only then opens, resets or
 * bumps the review row. Same order, so the two wait for each other and never deadlock; and
 * `FOR SHARE` conflicts with both of the company's row locks, so no edit can commit between the
 * decision's hash read and its write. Two decisions share the posting lock and serialise on the
 * review row.
 *
 * THE HASH IS SQL'S. `postingReviewContentHash` runs inside the locked read and again inside the
 * write statement, which stores what it computed and only when that equals the hash the reviewer
 * saw. TypeScript never computes or forwards a hash to be stored.
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
   * The RVM review row under `FOR UPDATE` (taken AFTER the posting, {@link lockTarget}), with the
   * state a reader saw. `undefined` when the posting has no row.
   */
  async lockReviewBefore(id: string, tx: Database): Promise<ReviewBefore | undefined> {
    const rows = await tx
      .select({
        state: jobPostingInstituteReviews.state,
        stateNow: sql<InstituteReviewState>`${rvmReviewStateNow()}`,
        reviewedAt: jobPostingInstituteReviews.reviewedAt,
      })
      .from(jobPostingInstituteReviews)
      .innerJoin(jobPostings, eq(jobPostings.id, jobPostingInstituteReviews.jobPostingId))
      .where(
        and(
          eq(jobPostingInstituteReviews.jobPostingId, id),
          eq(jobPostingInstituteReviews.instituteCode, RVM_INSTITUTE_CODE),
        ),
      )
      .limit(1)
      .for("update", { of: jobPostingInstituteReviews });
    return rows[0];
  }

  /**
   * THE DECISION, ONE STATEMENT. `target` computes the posting's hash; the upsert writes the
   * decision (a new row, or every decision column replaced — a re-decision replaces the earlier
   * one) only when that hash equals `expectedContentHash`, storing the hash it computed, and only
   * when something differs from what the row holds (a replayed decision is a no-op). The outer
   * select reports which of the three happened.
   */
  async writeDecision(tx: Database, input: DecisionWrite): Promise<DecisionWriteResult> {
    const rows = (await tx.execute(sql`
      WITH "target" AS (
        SELECT "jp"."id" AS "id", ${postingReviewContentHash("jp")} AS "content_hash"
          FROM ${jobPostings} AS "jp"
         WHERE "jp"."id" = ${input.jobPostingId}::uuid
      ), "written" AS (
        INSERT INTO ${jobPostingInstituteReviews} AS "r"
          ("job_posting_id", "institute_code", "state", "reviewer_ref", "reviewed_at", "reason",
           "branch_ids", "course_ids", "content_hash", "updated_at")
        SELECT "t"."id", ${RVM_INSTITUTE_CODE}::text, ${input.state}::text,
               ${input.reviewerRef}::text, now(), ${input.reason}::text,
               ${jsonOrNull(input.branchIds)}::jsonb, ${jsonOrNull(input.courseIds)}::jsonb,
               "t"."content_hash", now()
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
        WHERE ("r"."state", "r"."reviewer_ref", "r"."reason", "r"."branch_ids", "r"."course_ids",
               "r"."content_hash")
          IS DISTINCT FROM (EXCLUDED."state", EXCLUDED."reviewer_ref", EXCLUDED."reason",
               EXCLUDED."branch_ids", EXCLUDED."course_ids", EXCLUDED."content_hash")
        RETURNING "r"."reviewed_at"
      )
      SELECT "t"."content_hash" AS "content_hash", "w"."reviewed_at" AS "reviewed_at"
        FROM "target" AS "t" LEFT JOIN "written" AS "w" ON true
    `)) as unknown as { content_hash: string; reviewed_at: string | Date | null }[];

    const row = rows[0];
    if (row === undefined) return { outcome: "missing" };
    if (row.content_hash !== input.expectedContentHash) {
      return { outcome: "posting_changed", contentHash: row.content_hash };
    }
    if (row.reviewed_at === null) return { outcome: "unchanged", contentHash: row.content_hash };
    // A raw statement runs no column decoder: this client returns timestamps as text.
    return {
      outcome: "written",
      contentHash: row.content_hash,
      reviewedAt: new Date(row.reviewed_at),
    };
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

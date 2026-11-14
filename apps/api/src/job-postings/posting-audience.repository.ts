import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  RVM_INSTITUTE_CODE,
  jobPostingInstituteReviews,
  jobPostings,
  postingReviewContentHash,
  rvmReviewStateNow,
  rvmTargetingOptions,
  type Database,
  type InstituteReviewState,
  type RvmTargetingKind,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { RvmReviewFacts } from "./rvm-review-view";

/** One active targeting option, as the company's picker shows it. */
export interface TargetingOptionRow {
  kind: RvmTargetingKind;
  ref: string;
  label: string;
  sortOrder: number;
}

/**
 * #2746 — the institute side of a posting's audience: the RVM review row and the targeting
 * options. DATABASE ACCESS ONLY. Which of these writes a posting write makes is
 * `PostingAudienceService`'s decision; the statements here run on the caller's transaction (`tx`
 * is required on every write) so the review row commits with the posting it describes.
 *
 * Every review statement is keyed on the PK (`job_posting_id`, `institute_code`), so each is one
 * index probe. The "is this decision still for the content now?" test is the shared
 * `postingReviewContentHash` from @badabhai/db, never a copy.
 */
@Injectable()
export class PostingAudienceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The ACTIVE options of one kind among `refs` (an inactive or unknown ref is absent). */
  async activeOptionRefs(
    kind: RvmTargetingKind,
    refs: readonly string[],
    executor: Database = this.db,
  ): Promise<Set<string>> {
    if (refs.length === 0) return new Set();
    const rows = await executor
      .select({ ref: rvmTargetingOptions.ref })
      .from(rvmTargetingOptions)
      .where(
        and(
          eq(rvmTargetingOptions.kind, kind),
          eq(rvmTargetingOptions.active, true),
          inArray(rvmTargetingOptions.ref, [...refs]),
        ),
      );
    return new Set(rows.map((r) => r.ref));
  }

  /** Every active option, in the order Campus set (`sort_order`, then label, then ref). */
  async listActiveOptions(): Promise<TargetingOptionRow[]> {
    return this.db
      .select({
        kind: rvmTargetingOptions.kind,
        ref: rvmTargetingOptions.ref,
        label: rvmTargetingOptions.label,
        sortOrder: rvmTargetingOptions.sortOrder,
      })
      .from(rvmTargetingOptions)
      .where(eq(rvmTargetingOptions.active, true))
      .orderBy(
        asc(rvmTargetingOptions.kind),
        asc(rvmTargetingOptions.sortOrder),
        asc(rvmTargetingOptions.label),
        asc(rvmTargetingOptions.ref),
      );
  }

  /** The RVM review row, `pending`, unless one exists (a row is never replaced or deleted). */
  async ensurePendingReview(jobPostingId: string, tx: Database): Promise<void> {
    await tx
      .insert(jobPostingInstituteReviews)
      .values({ jobPostingId, instituteCode: RVM_INSTITUTE_CODE, state: "pending" })
      .onConflictDoNothing();
  }

  /**
   * A DECIDED row (approved or rejected) whose stored hash is not the posting's hash now goes back
   * to `pending`, every decision column cleared (`jpir_decision_chk`), `updated_at` bumped. The
   * posting row must already hold the edit (same transaction). Returns whether a row was reset.
   */
  async resetStaleDecision(jobPostingId: string, tx: Database): Promise<boolean> {
    const rows = await tx
      .update(jobPostingInstituteReviews)
      .set({
        state: "pending",
        reviewerRef: null,
        reviewedAt: null,
        reason: null,
        branchIds: null,
        courseIds: null,
        contentHash: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobPostingInstituteReviews.jobPostingId, jobPostingId),
          eq(jobPostingInstituteReviews.instituteCode, RVM_INSTITUTE_CODE),
          inArray(jobPostingInstituteReviews.state, ["approved", "rejected"]),
          sql`${jobPostingInstituteReviews.contentHash} IS DISTINCT FROM (
            SELECT ${postingReviewContentHash("jp")} FROM ${jobPostings} AS "jp"
            WHERE "jp"."id" = ${jobPostingInstituteReviews.jobPostingId})`,
        ),
      )
      .returning({ jobPostingId: jobPostingInstituteReviews.jobPostingId });
    return rows.length > 0;
  }

  /** Bump the review row's `updated_at` (Campus's feed cursor) without changing its state. */
  async touchReview(jobPostingId: string, tx: Database): Promise<void> {
    await tx
      .update(jobPostingInstituteReviews)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(jobPostingInstituteReviews.jobPostingId, jobPostingId),
          eq(jobPostingInstituteReviews.instituteCode, RVM_INSTITUTE_CODE),
        ),
      );
  }

  /**
   * The RVM review of each posting that has a row, read with the live-hash rule (`stateNow`: a
   * decision on older content reads `pending`). A posting with no row is absent from the map.
   */
  async reviewStatesFor(
    jobPostingIds: readonly string[],
    executor: Database = this.db,
  ): Promise<Map<string, RvmReviewFacts>> {
    if (jobPostingIds.length === 0) return new Map();
    const rows = await executor
      .select({
        id: jobPostings.id,
        stateNow: sql<InstituteReviewState | null>`${rvmReviewStateNow()}`,
        reason: jobPostingInstituteReviews.reason,
        reviewedAt: jobPostingInstituteReviews.reviewedAt,
      })
      .from(jobPostings)
      .innerJoin(
        jobPostingInstituteReviews,
        and(
          eq(jobPostingInstituteReviews.jobPostingId, jobPostings.id),
          eq(jobPostingInstituteReviews.instituteCode, RVM_INSTITUTE_CODE),
        ),
      )
      .where(inArray(jobPostings.id, [...jobPostingIds]));
    return new Map(
      rows.map((r) => [r.id, { stateNow: r.stateNow, reason: r.reason, reviewedAt: r.reviewedAt }]),
    );
  }
}

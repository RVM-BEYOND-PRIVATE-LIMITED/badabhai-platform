import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  instituteCompanies,
  jobPostingInstituteReviews,
  payers,
  postingReviewContentHash,
  rvmReviewStateNow,
  rvmTargetingOptions,
  RVM_STUDENT_AUDIENCES,
  type Database,
  type InstituteCode,
  type InstituteReviewState,
  type JobPayType,
  type JobPostingAudience,
  type JobShift,
  type PayerStatus,
} from "@badabhai/db";
import type { VacancyBand } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** One posting as the Campus feed reads it: the columns a student sees, and its review now. */
export interface CampusFeedRow {
  id: string;
  companyId: string;
  orgLabel: string;
  roleTitle: string;
  description: string | null;
  locationLabel: string | null;
  city: string | null;
  state: string | null;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  payType: JobPayType | null;
  vacancyBand: VacancyBand;
  shift: JobShift | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  requirements: string[] | null;
  benefits: string[] | null;
  /** Open AND not hidden: the only state in which it takes applications. */
  takesApplications: boolean;
  audience: JobPostingAudience;
  /** The review's narrowed lists when it has them, else the posting's own. */
  branchIds: number[];
  courseIds: string[];
  /** `rvmReviewStateNow`; null when no review row exists. */
  reviewStateNow: InstituteReviewState | null;
  contentHash: string;
  changedAt: Date;
}

export interface CampusFeedQuery {
  reviewState?: InstituteReviewState;
  branchId?: number;
  courseId?: string;
  /** Rows changed at or after this instant (the caller has already widened it by the overlap). */
  changedSince?: Date;
  /** Keyset: rows strictly after `(changedAt, id)`. */
  after?: { changedAt: Date; id: string };
  limit: number;
}

/** The `audit_logs.action` a Campus-created company is recorded under (with the staff ref). */
export const CAMPUS_COMPANY_CREATED_ACTION = "campus_link.company_created";

/**
 * Data access for the Campus postings routes (#2752 part E): the feed of postings whose audience
 * includes RVM students, the review recorded when the placement team posts for a company, and
 * the companies Campus created. The review rules are `@badabhai/db`'s `job-review` (one
 * definition of the hash and of "approved"), never a second spelling.
 */
@Injectable()
export class CampusPostingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * The feed, in `(changed_at, id)` order. Without `changedSince` only postings that take
   * applications are listed; with it, closed and hidden ones changed since are listed too (as
   * `closed`), so Campus learns about a close. The review filter is on the review state NOW (an
   * approval of older content reads `pending`).
   */
  async listFeed(q: CampusFeedQuery): Promise<CampusFeedRow[]> {
    const changedAt = sql`GREATEST(jp.updated_at, COALESCE(r.updated_at, jp.updated_at))`;
    const stateNow = rvmReviewStateNow({ posting: "jp", review: "r" });
    const branchIds = sql`COALESCE(r.branch_ids, jp.rvm_branch_ids)`;
    const courseIds = sql`COALESCE(r.course_ids, jp.rvm_course_ids)`;
    const filters = [
      sql`jp.audience IN (${sql.join(
        RVM_STUDENT_AUDIENCES.map((a) => sql`${a}`),
        sql`, `,
      )})`,
      sql`jp.payer_id IS NOT NULL`,
    ];
    if (q.changedSince === undefined) {
      filters.push(sql`jp.status = 'open' AND jp.hidden_at IS NULL`);
    } else {
      filters.push(sql`${changedAt} >= ${q.changedSince.toISOString()}::timestamptz`);
    }
    if (q.reviewState !== undefined) {
      // No row on an RVM audience reads `pending` (rvmReviewStateFor), so the filter does too.
      filters.push(sql`COALESCE(${stateNow}, 'pending') = ${q.reviewState}`);
    }
    if (q.branchId !== undefined) {
      filters.push(
        sql`(jsonb_array_length(${branchIds}) = 0 OR ${branchIds} @> ${JSON.stringify([q.branchId])}::jsonb)`,
      );
    }
    if (q.courseId !== undefined) {
      filters.push(
        sql`(jsonb_array_length(${courseIds}) = 0 OR ${courseIds} @> ${JSON.stringify([q.courseId])}::jsonb)`,
      );
    }
    if (q.after !== undefined) {
      filters.push(
        sql`(${changedAt}, jp.id) > (${q.after.changedAt.toISOString()}::timestamptz, ${q.after.id}::uuid)`,
      );
    }

    const rows = (await this.db.execute(sql`
      SELECT jp.id, jp.payer_id, jp.org_label, jp.role_title, jp.description, jp.location_label,
             jp.city, jp.state, jp.area, jp.pay_min, jp.pay_max, jp.pay_type, jp.vacancy_band,
             jp.shift, jp.min_experience_years, jp.max_experience_years, jp.requirements,
             jp.benefits, jp.audience,
             (jp.status = 'open' AND jp.hidden_at IS NULL) AS takes_applications,
             ${branchIds} AS branch_ids,
             ${courseIds} AS course_ids,
             ${stateNow} AS review_state_now,
             ${postingReviewContentHash("jp")} AS content_hash,
             ${changedAt} AS changed_at
      FROM job_postings jp
      LEFT JOIN job_posting_institute_reviews r
        ON r.job_posting_id = jp.id AND r.institute_code = 'rvm'
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY ${changedAt}, jp.id
      LIMIT ${q.limit}
    `)) as unknown as Record<string, unknown>[];
    return rows.map(toFeedRow);
  }

  /** The labels of the course ids the feed names (reference data); a missing one is absent. */
  async courseLabels(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ ref: rvmTargetingOptions.ref, label: rvmTargetingOptions.label })
      .from(rvmTargetingOptions)
      .where(
        and(eq(rvmTargetingOptions.kind, "course"), inArray(rvmTargetingOptions.ref, [...ids])),
      );
    return new Map(rows.map((r) => [r.ref, r.label]));
  }

  /** Whether Campus created this company (only those may be posted for). */
  async isCampusCompany(payerId: string, tx: Database = this.db): Promise<boolean> {
    const rows = await tx
      .select({ payerId: instituteCompanies.payerId })
      .from(instituteCompanies)
      .where(eq(instituteCompanies.payerId, payerId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The Campus-created companies holding this phone hash: id, status and the encrypted name only.
   * A company Campus did not create is never returned, so the route reveals nothing about which
   * phones are BadaBhai companies.
   */
  async findCampusCompaniesByPhoneHash(
    phoneHash: string,
  ): Promise<{ id: string; status: PayerStatus; orgNameEnc: string }[]> {
    return this.db
      .select({ id: payers.id, status: payers.status, orgNameEnc: payers.orgNameEnc })
      .from(payers)
      .innerJoin(instituteCompanies, eq(instituteCompanies.payerId, payers.id))
      .where(eq(payers.phoneHash, phoneHash))
      .limit(2);
  }

  /** Records that Campus created this company, with the staff member in `audit_logs`. */
  async markCampusCompany(
    tx: Database,
    payerId: string,
    instituteCode: InstituteCode,
    staffRef: string,
  ): Promise<void> {
    await tx.insert(instituteCompanies).values({ payerId, instituteCode }).onConflictDoNothing();
    await tx.insert(auditLogs).values({
      actorType: "campus_service",
      actorId: null,
      action: CAMPUS_COMPANY_CREATED_ACTION,
      entityType: "payer",
      entityId: payerId,
      metadata: { institute_code: instituteCode, staff_ref: staffRef },
    });
  }

  /**
   * Records the placement team's approval of a posting it just created for a company: the review
   * row `approved` by `reviewerRef`, with the hash of the posting AS STORED NOW. The posting row is
   * locked first (`FOR NO KEY UPDATE`), then the review row is written — the house lock order
   * (`job-review.ts`), so a concurrent company edit either lands before (and is what was approved)
   * or after (and un-approves it by changing the hash).
   */
  async approveAsCreated(tx: Database, jobPostingId: string, reviewerRef: string): Promise<void> {
    await tx.execute(
      sql`SELECT 1 FROM job_postings WHERE id = ${jobPostingId}::uuid FOR NO KEY UPDATE`,
    );
    const now = new Date();
    await tx
      .insert(jobPostingInstituteReviews)
      .values({
        jobPostingId,
        instituteCode: "rvm",
        state: "approved",
        reviewerRef,
        reviewedAt: now,
        contentHash: sql`(SELECT ${postingReviewContentHash("p")} FROM job_postings p WHERE p.id = ${jobPostingId}::uuid)`,
        // The review row's one clock (#2746 PR 5): the database's, so the feed cursor is monotonic.
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: [jobPostingInstituteReviews.jobPostingId, jobPostingInstituteReviews.instituteCode],
        set: {
          state: "approved",
          reviewerRef,
          reviewedAt: now,
          reason: null,
          contentHash: sql`(SELECT ${postingReviewContentHash("p")} FROM job_postings p WHERE p.id = ${jobPostingId}::uuid)`,
          updatedAt: sql`clock_timestamp()`,
        },
      });
  }
}

function toFeedRow(r: Record<string, unknown>): CampusFeedRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id),
    companyId: String(r.payer_id),
    orgLabel: String(r.org_label),
    roleTitle: String(r.role_title),
    description: (r.description as string | null) ?? null,
    locationLabel: (r.location_label as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    area: (r.area as string | null) ?? null,
    payMin: num(r.pay_min),
    payMax: num(r.pay_max),
    payType: (r.pay_type as JobPayType | null) ?? null,
    vacancyBand: r.vacancy_band as VacancyBand,
    shift: (r.shift as JobShift | null) ?? null,
    minExperienceYears: num(r.min_experience_years),
    maxExperienceYears: num(r.max_experience_years),
    requirements: (r.requirements as string[] | null) ?? null,
    benefits: (r.benefits as string[] | null) ?? null,
    takesApplications: r.takes_applications === true,
    audience: r.audience as JobPostingAudience,
    branchIds: (r.branch_ids as number[] | null) ?? [],
    courseIds: (r.course_ids as string[] | null) ?? [],
    reviewStateNow: (r.review_state_now as InstituteReviewState | null) ?? null,
    contentHash: String(r.content_hash),
    changedAt: r.changed_at instanceof Date ? r.changed_at : new Date(String(r.changed_at)),
  };
}

import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import {
  jobPostings,
  materializeJobReachWithin,
  postingReviewContentHash,
  reachesBadaBhaiWorkers,
  reachesRvmStudents,
  rvmReviewStateNow,
  type Database,
  type InstituteReviewState,
  type JobPostingAudience,
  type JobWorkerVisibilityOrigin,
  type JobWorkerVisibilityState,
} from "@badabhai/db";
import type { JobPostingStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { AudienceListFilter, ShownTo } from "./admin-posting-audience.dto";

/** One posting locked for an admin audience decision, with everything the rules read. */
export interface LockedAudiencePosting {
  id: string;
  status: JobPostingStatus;
  /** Non-null on an agency job's synced copy (ADR-0050): BadaBhai only, by a database rule. */
  syncSource: string | null;
  roleKind: string | null;
  audience: JobPostingAudience;
  rvmBranchIds: number[];
  rvmCourseIds: string[];
  /** The #2891 hold, on a Campus-origin posting only (locked after the posting). */
  hold: { state: JobWorkerVisibilityState; decided: boolean; origin: JobWorkerVisibilityOrigin } | null;
  /** The latest admin decision, if any (locked after the hold). */
  decision: { audience: JobPostingAudience; contentHash: string } | null;
  /** The posting's review content hash now, before this decision writes anything. */
  contentHashNow: string;
  /** The RVM review as it stands now (`rvmReviewStateNow`); null when the posting has no row. */
  reviewStateNow: InstituteReviewState | null;
}

/** One live posting as the admin "where jobs show" list reads it. */
export interface AudienceListRow {
  jobPostingId: string;
  payerId: string | null;
  orgLabel: string;
  roleTitle: string;
  city: string | null;
  roleKind: string | null;
  vacancyBand: string;
  status: JobPostingStatus;
  hidden: boolean;
  audience: JobPostingAudience;
  rvmBranchIds: number[];
  rvmCourseIds: string[];
  shownTo: ShownTo;
  taughtAtCampus: boolean;
  rvmReviewStateNow: InstituteReviewState | null;
  campusOrigin: JobWorkerVisibilityOrigin | null;
  holdState: JobWorkerVisibilityState | null;
  decidedByAdminId: string | null;
  decidedAt: Date | null;
  changedSinceDecision: boolean;
  createdAt: Date;
}

/**
 * #2956 — data access for an admin's decision on WHERE A POSTING SHOWS. Admin side only: every
 * worker and Campus read keeps reading `job_postings.audience` (and the #2891 hold) through
 * `reachesBadaBhaiWorkers()` / `reachesRvmStudents()` and nowhere else.
 *
 * LOCK ORDER, the house rule (`@badabhai/db` `job-review.ts`): THE POSTING ROW FIRST (`FOR NO KEY
 * UPDATE`), then the Campus hold row, then the decision row, and the RVM review row only after
 * the posting has been written. The company edit, the #2891 admin route and the Campus review
 * all take the posting first, so none of them can deadlock with this one.
 *
 * ONE CLOCK FOR CAMPUS'S FEED CURSOR: every review-row write stamps `updated_at =
 * clock_timestamp()`, as the company and Campus writes do.
 */
@Injectable()
export class AdminPostingAudienceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** Lock one posting and read what the rules need. Undefined when there is no such posting. */
  async lock(tx: Database, jobPostingId: string): Promise<LockedAudiencePosting | undefined> {
    const postings = (await tx.execute(sql`
      SELECT jp.id, jp.status, jp.sync_source, jp.role_kind, jp.audience,
             jp.rvm_branch_ids, jp.rvm_course_ids
      FROM job_postings jp
      WHERE jp.id = ${jobPostingId}::uuid
      FOR NO KEY UPDATE OF jp
    `)) as unknown as Record<string, unknown>[];
    const p = postings[0];
    if (p === undefined) return undefined;

    const holds = (await tx.execute(sql`
      SELECT v.state, (v.decided_at IS NOT NULL) AS decided, v.origin
      FROM job_posting_worker_visibility v
      WHERE v.job_posting_id = ${jobPostingId}::uuid
      FOR UPDATE OF v
    `)) as unknown as Record<string, unknown>[];
    const decisions = (await tx.execute(sql`
      SELECT d.audience, d.content_hash
      FROM job_posting_audience_decisions d
      WHERE d.job_posting_id = ${jobPostingId}::uuid
      FOR UPDATE OF d
    `)) as unknown as Record<string, unknown>[];
    const facts = (await tx.execute(sql`
      SELECT ${postingReviewContentHash("jp")} AS content_hash,
             ${rvmReviewStateNow({ posting: "jp", review: "r" })} AS review_state_now
      FROM job_postings jp
      LEFT JOIN job_posting_institute_reviews r
        ON r.job_posting_id = jp.id AND r.institute_code = 'rvm'
      WHERE jp.id = ${jobPostingId}::uuid
    `)) as unknown as Record<string, unknown>[];

    const hold = holds[0];
    const decision = decisions[0];
    return {
      id: String(p.id),
      status: p.status as JobPostingStatus,
      syncSource: (p.sync_source as string | null) ?? null,
      roleKind: (p.role_kind as string | null) ?? null,
      audience: p.audience as JobPostingAudience,
      rvmBranchIds: (p.rvm_branch_ids as number[] | null) ?? [],
      rvmCourseIds: (p.rvm_course_ids as string[] | null) ?? [],
      hold:
        hold === undefined
          ? null
          : {
              state: hold.state as JobWorkerVisibilityState,
              decided: hold.decided === true,
              origin: hold.origin as JobWorkerVisibilityOrigin,
            },
      decision:
        decision === undefined
          ? null
          : {
              audience: decision.audience as JobPostingAudience,
              contentHash: String(decision.content_hash),
            },
      contentHashNow: String(facts[0]?.content_hash),
      reviewStateNow: (facts[0]?.review_state_now as InstituteReviewState | null) ?? null,
    };
  }

  /** Is this trade an ACTIVE row of the Campus trade list (#2957)? */
  async isCampusTrade(tx: Database, roleKind: string): Promise<boolean> {
    const rows = (await tx.execute(sql`
      SELECT 1 FROM campus_trades
      WHERE trade_key = ${roleKind} AND removed_at IS NULL
    `)) as unknown as unknown[];
    return rows.length > 0;
  }

  /** Write the audience and targeting on the locked posting. */
  async writeAudience(
    tx: Database,
    jobPostingId: string,
    write: { audience: JobPostingAudience; rvmBranchIds: number[]; rvmCourseIds: string[] },
  ): Promise<void> {
    await tx
      .update(jobPostings)
      .set({
        audience: write.audience,
        rvmBranchIds: write.rvmBranchIds,
        rvmCourseIds: write.rvmCourseIds,
        updatedAt: new Date(),
      })
      .where(sql`${jobPostings.id} = ${jobPostingId}::uuid`);
  }

  /**
   * The RVM review row, APPROVED by the admin for the posting's content as it is now (the posting
   * row already holds this decision's write, same transaction). The admin's choice to show a job
   * on Campus is the approval (#2956, the default owners are asked to confirm); the placement team
   * can still reject it from Campus with a newer decision. A narrowing a previous decision stored
   * is cleared: the admin's targeting is the posting's own.
   */
  async approveAsAdmin(tx: Database, jobPostingId: string, adminId: string): Promise<void> {
    const hash = sql`(SELECT ${postingReviewContentHash("p")} FROM job_postings p WHERE p.id = ${jobPostingId}::uuid)`;
    await tx.execute(sql`
      INSERT INTO job_posting_institute_reviews
        (job_posting_id, institute_code, state, reviewer_ref, reviewed_at, content_hash, updated_at)
      VALUES (${jobPostingId}::uuid, 'rvm', 'approved', ${adminId}, now(), ${hash},
              clock_timestamp())
      ON CONFLICT (job_posting_id, institute_code) DO UPDATE
      SET state = 'approved', reviewer_ref = ${adminId}, reviewed_at = now(), reason = NULL,
          branch_ids = NULL, course_ids = NULL, content_hash = ${hash},
          updated_at = clock_timestamp()
    `);
  }

  /**
   * Bump the RVM review row (if any) so Campus's feed reads the posting again: a posting that left
   * Campus reaches it as closed (the review row is never deleted, and the feed is driven from it).
   */
  async touchReview(tx: Database, jobPostingId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE job_posting_institute_reviews SET updated_at = clock_timestamp()
      WHERE job_posting_id = ${jobPostingId}::uuid AND institute_code = 'rvm'
    `);
  }

  /** Record an admin decision on a Campus-origin posting's hold (#2891), already locked. */
  async decideHold(
    tx: Database,
    jobPostingId: string,
    state: JobWorkerVisibilityState,
    adminId: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE job_posting_worker_visibility
      SET state = ${state}, decided_by_admin_id = ${adminId}::uuid, decided_at = now(),
          updated_at = now()
      WHERE job_posting_id = ${jobPostingId}::uuid
    `);
  }

  /** The latest decision, for the posting's content as it is now (after this decision's write). */
  async recordDecision(
    tx: Database,
    jobPostingId: string,
    audience: JobPostingAudience,
    adminId: string,
  ): Promise<void> {
    const hash = sql`(SELECT ${postingReviewContentHash("p")} FROM job_postings p WHERE p.id = ${jobPostingId}::uuid)`;
    await tx.execute(sql`
      INSERT INTO job_posting_audience_decisions
        (job_posting_id, audience, content_hash, decided_by_admin_id, decided_at, updated_at)
      VALUES (${jobPostingId}::uuid, ${audience}, ${hash}, ${adminId}::uuid, now(), now())
      ON CONFLICT (job_posting_id) DO UPDATE
      SET audience = EXCLUDED.audience, content_hash = EXCLUDED.content_hash,
          decided_by_admin_id = EXCLUDED.decided_by_admin_id, decided_at = now(),
          updated_at = now()
    `);
  }

  /**
   * Clear the posting's `job_reach` rows after it stopped reaching BadaBhai workers: the shared
   * reach core with empty sets is its "clear this posting" form. Post-commit and rebuildable; the
   * worker reads apply the fragment too, so a leftover row is never shown.
   */
  async clearReach(jobPostingId: string): Promise<void> {
    await this.withTransaction((tx) => materializeJobReachWithin(tx, jobPostingId, [], []));
  }

  /**
   * The list: live (open or paused) postings, agency copies left out, oldest first, keyset on
   * `(created_at, id)`. Where it shows is read through the two fragments, so a Campus-origin
   * posting held from workers counts as Campus only.
   */
  async list(q: {
    filter: AudienceListFilter;
    limit: number;
    after?: { createdAt: Date; id: string };
  }): Promise<AudienceListRow[]> {
    const toWorkers = reachesBadaBhaiWorkers("jp");
    const toCampus = reachesRvmStudents(sql.raw("jp.audience"));
    const changed = sql`(d.job_posting_id IS NOT NULL AND d.content_hash <> ${postingReviewContentHash("jp")})`;
    const filters: Record<AudienceListFilter, SQL> = {
      to_decide: sql`d.job_posting_id IS NULL
        AND (ct.trade_key IS NOT NULL OR (v.job_posting_id IS NOT NULL AND v.decided_at IS NULL))`,
      campus: sql`${toCampus} AND NOT ${toWorkers}`,
      both: sql`${toCampus} AND ${toWorkers}`,
      badabhai: sql`${toWorkers} AND NOT ${toCampus}`,
      changed,
    };
    const after =
      q.after === undefined
        ? sql``
        : sql`AND (jp.created_at, jp.id) > (${q.after.createdAt.toISOString()}::timestamptz, ${q.after.id}::uuid)`;
    const rows = (await this.db.execute(sql`
      SELECT jp.id, jp.payer_id, jp.org_label, jp.role_title, jp.city, jp.role_kind,
             jp.vacancy_band, jp.status, (jp.hidden_at IS NOT NULL) AS hidden, jp.audience,
             jp.rvm_branch_ids, jp.rvm_course_ids, jp.created_at,
             ${toCampus} AS to_campus, ${toWorkers} AS to_workers,
             (ct.trade_key IS NOT NULL) AS taught_at_campus,
             ${rvmReviewStateNow({ posting: "jp", review: "r" })} AS review_state_now,
             v.origin, v.state AS hold_state,
             d.decided_by_admin_id, d.decided_at, ${changed} AS changed_since_decision
      FROM job_postings jp
      LEFT JOIN job_posting_worker_visibility v ON v.job_posting_id = jp.id
      LEFT JOIN job_posting_audience_decisions d ON d.job_posting_id = jp.id
      LEFT JOIN job_posting_institute_reviews r
        ON r.job_posting_id = jp.id AND r.institute_code = 'rvm'
      LEFT JOIN campus_trades ct ON ct.trade_key = jp.role_kind AND ct.removed_at IS NULL
      WHERE jp.status IN ('open', 'paused') AND jp.sync_source IS NULL
        AND ${filters[q.filter]} ${after}
      ORDER BY jp.created_at, jp.id
      LIMIT ${q.limit}
    `)) as unknown as Record<string, unknown>[];
    return rows.map(toListRow);
  }
}

function toListRow(r: Record<string, unknown>): AudienceListRow {
  const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
  const toCampus = r.to_campus === true;
  const toWorkers = r.to_workers === true;
  return {
    jobPostingId: String(r.id),
    payerId: (r.payer_id as string | null) ?? null,
    orgLabel: String(r.org_label),
    roleTitle: String(r.role_title),
    city: (r.city as string | null) ?? null,
    roleKind: (r.role_kind as string | null) ?? null,
    vacancyBand: String(r.vacancy_band),
    status: r.status as JobPostingStatus,
    hidden: r.hidden === true,
    audience: r.audience as JobPostingAudience,
    rvmBranchIds: (r.rvm_branch_ids as number[] | null) ?? [],
    rvmCourseIds: (r.rvm_course_ids as string[] | null) ?? [],
    shownTo: shownTo(toCampus, toWorkers),
    taughtAtCampus: r.taught_at_campus === true,
    rvmReviewStateNow: (r.review_state_now as InstituteReviewState | null) ?? null,
    campusOrigin: (r.origin as JobWorkerVisibilityOrigin | null) ?? null,
    holdState: (r.hold_state as JobWorkerVisibilityState | null) ?? null,
    decidedByAdminId: (r.decided_by_admin_id as string | null) ?? null,
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : date(r.decided_at),
    changedSinceDecision: r.changed_since_decision === true,
    createdAt: date(r.created_at),
  };
}

/** Where a posting shows, from the two fragments' answers. */
export function shownTo(toCampus: boolean, toWorkers: boolean): ShownTo {
  if (toCampus && toWorkers) return "both";
  if (toCampus) return "campus";
  if (toWorkers) return "badabhai";
  return "nobody";
}

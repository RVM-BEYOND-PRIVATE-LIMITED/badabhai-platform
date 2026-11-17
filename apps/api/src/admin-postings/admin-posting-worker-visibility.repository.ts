import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  materializeJobReachWithin,
  rvmReviewStateNow,
  type Database,
  type InstituteReviewState,
  type JobPostingAudience,
  type JobWorkerVisibilityOrigin,
  type JobWorkerVisibilityState,
} from "@badabhai/db";
import type { JobPostingStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { WorkerVisibilityListFilter } from "./admin-posting-worker-visibility.dto";

/** One Campus-origin posting as the admin list reads it. */
export interface WorkerVisibilityListRow {
  jobPostingId: string;
  payerId: string | null;
  orgLabel: string;
  roleTitle: string;
  city: string | null;
  /** The posting's trade pick (`role_kind`); `on` needs one of the 16 trades. */
  roleKind: string | null;
  status: JobPostingStatus;
  hidden: boolean;
  audience: JobPostingAudience;
  /** The RVM review as it stands now (`rvmReviewStateNow`); null when the posting has no row. */
  rvmReviewStateNow: InstituteReviewState | null;
  origin: JobWorkerVisibilityOrigin;
  state: JobWorkerVisibilityState;
  decidedByAdminId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** A visibility row locked for a change, with the posting's audience. */
export interface LockedVisibility {
  state: JobWorkerVisibilityState;
  decided: boolean;
  origin: JobWorkerVisibilityOrigin;
  audience: JobPostingAudience;
  roleKind: string | null;
}

/**
 * #2891 — data access for a Campus-origin posting's BadaBhai worker visibility
 * (`job_posting_worker_visibility`). The admin side only: the worker side reads the table through
 * `reachesBadaBhaiWorkers()` and nowhere else. Never inserts a row: a row exists only because a
 * Campus writer held the posting (`holdPostingFromWorkers`).
 */
@Injectable()
export class AdminPostingWorkerVisibilityRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * The list, oldest first, keyset on `(created_at, id)`. `waiting` = held and never decided; `off`
   * = held by an admin's decision; `on` = opened.
   */
  async list(q: {
    filter: WorkerVisibilityListFilter;
    limit: number;
    after?: { createdAt: Date; id: string };
  }): Promise<WorkerVisibilityListRow[]> {
    const filter =
      q.filter === "on"
        ? sql`v.state = 'on'`
        : q.filter === "off"
          ? sql`v.state = 'off' AND v.decided_at IS NOT NULL`
          : sql`v.state = 'off' AND v.decided_at IS NULL`;
    const after =
      q.after === undefined
        ? sql``
        : sql`AND (v.created_at, v.job_posting_id) > (${q.after.createdAt.toISOString()}::timestamptz, ${q.after.id}::uuid)`;
    const rows = (await this.db.execute(sql`
      SELECT v.job_posting_id, jp.payer_id, jp.org_label, jp.role_title, jp.city, jp.role_kind,
             jp.status,
             (jp.hidden_at IS NOT NULL) AS hidden, jp.audience,
             ${rvmReviewStateNow({ posting: "jp", review: "r" })} AS review_state_now,
             v.origin, v.state, v.decided_by_admin_id, v.decided_at, v.created_at
      FROM job_posting_worker_visibility v
      JOIN job_postings jp ON jp.id = v.job_posting_id
      LEFT JOIN job_posting_institute_reviews r
        ON r.job_posting_id = jp.id AND r.institute_code = 'rvm'
      WHERE ${filter} ${after}
      ORDER BY v.created_at, v.job_posting_id
      LIMIT ${q.limit}
    `)) as unknown as Record<string, unknown>[];
    return rows.map(toListRow);
  }

  /**
   * Lock one posting's visibility row for a change: the posting row FIRST (`FOR NO KEY UPDATE`,
   * the house lock order of `job-review.ts`), then the visibility row (`FOR UPDATE`). Undefined when
   * the posting has no visibility row, i.e. it is not Campus-origin.
   */
  async lock(tx: Database, jobPostingId: string): Promise<LockedVisibility | undefined> {
    const rows = (await tx.execute(sql`
      SELECT v.state, (v.decided_at IS NOT NULL) AS decided, v.origin, jp.audience, jp.role_kind
      FROM job_postings jp
      JOIN job_posting_worker_visibility v ON v.job_posting_id = jp.id
      WHERE jp.id = ${jobPostingId}::uuid
      FOR NO KEY UPDATE OF jp
      FOR UPDATE OF v
    `)) as unknown as Record<string, unknown>[];
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      state: row.state as JobWorkerVisibilityState,
      decided: row.decided === true,
      origin: row.origin as JobWorkerVisibilityOrigin,
      audience: row.audience as JobPostingAudience,
      roleKind: (row.role_kind as string | null) ?? null,
    };
  }

  /** Record an admin's decision on a locked row. */
  async decide(
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

  /**
   * Clear the posting's `job_reach` rows after its visibility went `off`: the shared reach core with
   * empty sets is its "clear this posting" form (and the core would refuse to write a row for a held
   * posting anyway, because it applies the fragment itself).
   * Post-commit and rebuildable; the worker reads apply the fragment too, so a leftover row is
   * never shown.
   */
  async clearReach(jobPostingId: string): Promise<void> {
    await this.withTransaction((tx) => materializeJobReachWithin(tx, jobPostingId, [], []));
  }
}

function toListRow(r: Record<string, unknown>): WorkerVisibilityListRow {
  const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
  return {
    jobPostingId: String(r.job_posting_id),
    payerId: (r.payer_id as string | null) ?? null,
    orgLabel: String(r.org_label),
    roleTitle: String(r.role_title),
    city: (r.city as string | null) ?? null,
    roleKind: (r.role_kind as string | null) ?? null,
    status: r.status as JobPostingStatus,
    hidden: r.hidden === true,
    audience: r.audience as JobPostingAudience,
    rvmReviewStateNow: (r.review_state_now as InstituteReviewState | null) ?? null,
    origin: r.origin as JobWorkerVisibilityOrigin,
    state: r.state as JobWorkerVisibilityState,
    decidedByAdminId: (r.decided_by_admin_id as string | null) ?? null,
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : date(r.decided_at),
    createdAt: date(r.created_at),
  };
}

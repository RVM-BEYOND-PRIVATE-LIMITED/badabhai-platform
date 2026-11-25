import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  CAMPUS_WORKER_VISIBILITY_ORIGINS,
  type CampusWorkerVisibilityOrigin,
  type Database,
  type JobWorkerVisibilityState,
} from "@badabhai/db";
import { GENERAL_CNC_SKILL_ID } from "@badabhai/taxonomy";
import type { JobPostingStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** One queued posting as the narrow list reads it. */
export interface NarrowQueueRow {
  jobPostingId: string;
  payerId: string | null;
  orgLabel: string;
  roleTitle: string;
  status: JobPostingStatus;
  origin: CampusWorkerVisibilityOrigin;
  postedAt: Date;
}

/** A posting locked for narrowing, with everything the rules read. */
export interface LockedNarrowPosting {
  id: string;
  status: JobPostingStatus;
  /** Non-null on an agency job's synced copy (ADR-0050): never narrowable. */
  syncSource: string | null;
  roleKind: string | null;
  matchSkillIds: string[];
  origin: CampusWorkerVisibilityOrigin | null;
  visibilityState: JobWorkerVisibilityState | null;
}

const CAMPUS_ORIGIN = sql.raw(
  `v.origin IN (${CAMPUS_WORKER_VISIBILITY_ORIGINS.map((o) => `'${o}'`).join(", ")})`,
);

/** The general-CNC singleton, as stored JSONB: the queue's only match set. */
const GENERAL_CNC_SET = sql`'${sql.raw(JSON.stringify([GENERAL_CNC_SKILL_ID]))}'::jsonb`;

/**
 * #3033 — data access for the Campus narrow queue. Admin side only.
 *
 * The queue is a READ over the two tables the Campus writers already maintain: an OPEN
 * `job_postings` row whose `match_skill_ids` is exactly the general CNC skill, joined to
 * its `job_posting_worker_visibility` hold row (both Campus writers hold every posting, so
 * the origin join is also the "came from Campus" mark — no parallel storage).
 */
@Injectable()
export class AdminCampusNarrowRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The queue, oldest first, keyset on `(created_at, id)`. `posted_at` is when the posting
   * became worker-visible, else when it was created (a draft that sat first).
   */
  async list(q: {
    limit: number;
    after?: { createdAt: Date; id: string };
  }): Promise<NarrowQueueRow[]> {
    const after =
      q.after === undefined
        ? sql``
        : sql`AND (jp.created_at, jp.id) > (${q.after.createdAt.toISOString()}::timestamptz, ${q.after.id}::uuid)`;
    const rows = (await this.db.execute(sql`
      SELECT jp.id AS job_posting_id, jp.payer_id, jp.org_label, jp.role_title, jp.status,
             v.origin, COALESCE(jp.published_at, jp.created_at) AS posted_at
      FROM job_postings jp
      JOIN job_posting_worker_visibility v ON v.job_posting_id = jp.id
      WHERE jp.status = 'open'
        AND ${CAMPUS_ORIGIN}
        AND jp.match_skill_ids = ${GENERAL_CNC_SET}
        ${after}
      ORDER BY jp.created_at, jp.id
      LIMIT ${q.limit}
    `)) as unknown as Record<string, unknown>[];
    return rows.map(toQueueRow);
  }

  /** Read one posting with its Campus origin for the narrow rules. No lock: mirrors `resolve`. */
  async findForNarrow(jobPostingId: string): Promise<LockedNarrowPosting | undefined> {
    const rows = (await this.db.execute(sql`
      SELECT jp.id, jp.status, jp.sync_source, jp.role_kind, jp.match_skill_ids,
             v.origin, v.state
      FROM job_postings jp
      LEFT JOIN job_posting_worker_visibility v
        ON v.job_posting_id = jp.id AND ${CAMPUS_ORIGIN}
      WHERE jp.id = ${jobPostingId}::uuid
    `)) as unknown as Record<string, unknown>[];
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: String(row.id),
      status: row.status as JobPostingStatus,
      syncSource: (row.sync_source as string | null) ?? null,
      roleKind: (row.role_kind as string | null) ?? null,
      matchSkillIds: Array.isArray(row.match_skill_ids) ? (row.match_skill_ids as string[]) : [],
      origin: (row.origin as CampusWorkerVisibilityOrigin | null) ?? null,
      visibilityState: (row.state as JobWorkerVisibilityState | null) ?? null,
    };
  }
}

function dateOf(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toQueueRow(r: Record<string, unknown>): NarrowQueueRow {
  return {
    jobPostingId: String(r.job_posting_id),
    payerId: (r.payer_id as string | null) ?? null,
    orgLabel: String(r.org_label),
    roleTitle: String(r.role_title),
    status: r.status as JobPostingStatus,
    origin: r.origin as CampusWorkerVisibilityOrigin,
    postedAt: dateOf(r.posted_at),
  };
}

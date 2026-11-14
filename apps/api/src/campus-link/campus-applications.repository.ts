import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  applications,
  approvedForRvmStudents,
  instituteApplications,
  RVM_STUDENT_AUDIENCES,
  type Database,
  type InstituteApplicationRow,
  type InstituteCode,
  type JobPostingAudience,
} from "@badabhai/db";
import type { ApplicantStage } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** What an apply needs to know about a posting, read under the apply's lock. */
export interface CampusPostingGate {
  status: string;
  hidden: boolean;
  audience: JobPostingAudience;
  /** `approvedForRvmStudents`: an approval of the content as it is now. */
  approved: boolean;
}

/** A Campus application with the student reference behind it and the company's stage now. */
export interface CampusApplicationView extends InstituteApplicationRow {
  studentRef: string | null;
  /** The company's stage for him (`payer_applicant_stages`); null = never moved (`new`). */
  stage: ApplicantStage | null;
  /** When Campus must learn of a change: the later of the row and the company's stage. */
  changedAt: Date;
}

/**
 * Data access for Campus applications (#2752 item 8). Every write takes the caller's transaction,
 * so the `applications` row the company sees, the Campus record and their events commit together.
 */
@Injectable()
export class CampusApplicationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** Serialises every write of one Campus application ref for the rest of this transaction. */
  async lockRef(tx: Database, instituteCode: InstituteCode, externalRef: string): Promise<void> {
    const key = `institute_application:${instituteCode}:${externalRef}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  /**
   * The posting's apply facts, the row locked `FOR SHARE` inside a transaction: a close or an edit
   * committed first is seen (and refuses the apply), one arriving after waits for this apply. Undefined
   * for an unknown posting.
   */
  async postingGate(
    postingId: string,
    tx: Database = this.db,
  ): Promise<CampusPostingGate | undefined> {
    const lock = tx === this.db ? sql`` : sql` FOR SHARE OF jp`;
    const rows = (await tx.execute(sql`
      SELECT jp.status, (jp.hidden_at IS NOT NULL) AS hidden, jp.audience,
             ${approvedForRvmStudents("jp")} AS approved
      FROM job_postings jp
      WHERE jp.id = ${postingId}::uuid${lock}
    `)) as unknown as {
      status: string;
      hidden: boolean;
      audience: JobPostingAudience;
      approved: boolean;
    }[];
    return rows[0];
  }

  /** Whether the audience includes RVM students (`RVM_STUDENT_AUDIENCES`). */
  static reachesRvm(audience: JobPostingAudience): boolean {
    return (RVM_STUDENT_AUDIENCES as readonly string[]).includes(audience);
  }

  /** The Campus application Campus knows by this ref, with its student and stage. */
  async findByRef(
    instituteCode: InstituteCode,
    externalRef: string,
    tx: Database = this.db,
  ): Promise<CampusApplicationView | undefined> {
    const rows = await this.selectViews(
      tx,
      sql`ia.institute_code = ${instituteCode} AND ia.external_ref = ${externalRef}`,
      sql`ORDER BY ia.id`,
      1,
    );
    return rows[0];
  }

  /** The Campus application already recorded for this worker and posting, if any. */
  async findForWorkerPosting(
    tx: Database,
    workerId: string,
    postingId: string,
  ): Promise<InstituteApplicationRow | undefined> {
    const rows = await tx
      .select()
      .from(instituteApplications)
      .where(
        and(
          eq(instituteApplications.workerId, workerId),
          eq(instituteApplications.jobPostingId, postingId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The worker's applied `applications` row on this posting, if he has one (any surface). */
  async findApplied(
    tx: Database,
    workerId: string,
    postingId: string,
  ): Promise<string | undefined> {
    const rows = await tx
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.workerId, workerId),
          eq(applications.jobPostingId, postingId),
          eq(applications.action, "applied"),
        ),
      )
      .limit(1);
    return rows[0]?.id;
  }

  /**
   * The `applications` row the company sees. Outside the reach gate on purpose (#2752 item 8): a
   * student has no `job_reach` row, and no rank snapshot is stored for a Campus apply.
   */
  async insertApplication(tx: Database, workerId: string, postingId: string): Promise<string> {
    const [row] = await tx
      .insert(applications)
      .values({ jobPostingId: postingId, workerId, action: "applied", sourceSurface: "other" })
      .returning({ id: applications.id });
    return row!.id;
  }

  async insertCampusApplication(
    tx: Database,
    row: {
      instituteCode: InstituteCode;
      externalRef: string;
      applicationId: string;
      jobPostingId: string;
      workerId: string;
      campusAppliedAt: Date | null;
    },
  ): Promise<InstituteApplicationRow> {
    const [inserted] = await tx.insert(instituteApplications).values(row).returning();
    return inserted!;
  }

  /**
   * A withdrawal: the company no longer sees him (the `applications` row goes), and the Campus
   * record keeps the fact so the feed can say `withdrawn`.
   */
  async withdraw(tx: Database, row: InstituteApplicationRow, now: Date): Promise<void> {
    if (row.applicationId !== null) {
      await tx.delete(applications).where(eq(applications.id, row.applicationId));
    }
    await tx
      .update(instituteApplications)
      .set({ withdrawnAt: now, applicationId: null, updatedAt: now })
      .where(eq(instituteApplications.id, row.id));
  }

  /** The status feed, in `(changed_at, id)` order. */
  async listFeed(q: {
    instituteCode: InstituteCode;
    changedSince?: Date;
    after?: { changedAt: Date; id: string };
    limit: number;
  }): Promise<CampusApplicationView[]> {
    const filters = [sql`ia.institute_code = ${q.instituteCode}`];
    if (q.changedSince !== undefined) {
      filters.push(sql`${CHANGED_AT} >= ${q.changedSince.toISOString()}::timestamptz`);
    }
    if (q.after !== undefined) {
      filters.push(
        sql`(${CHANGED_AT}, ia.id) > (${q.after.changedAt.toISOString()}::timestamptz, ${q.after.id}::uuid)`,
      );
    }
    return this.selectViews(
      this.db,
      sql.join(filters, sql` AND `),
      sql`ORDER BY ${CHANGED_AT}, ia.id`,
      q.limit,
    );
  }

  private async selectViews(
    executor: Database,
    where: ReturnType<typeof sql>,
    order: ReturnType<typeof sql>,
    limit: number,
  ): Promise<CampusApplicationView[]> {
    const rows = (await executor.execute(sql`
      SELECT ia.id, ia.institute_code, ia.external_ref, ia.application_id, ia.job_posting_id,
             ia.worker_id, ia.campus_applied_at, ia.withdrawn_at, ia.created_at, ia.updated_at,
             il.student_ref, s.stage, ${CHANGED_AT} AS changed_at
      FROM institute_applications ia
      LEFT JOIN worker_institute_links il ON il.worker_id = ia.worker_id
      LEFT JOIN payer_applicant_stages s
        ON s.posting_kind = 'company_posting'
       AND s.posting_id = ia.job_posting_id
       AND s.worker_id = ia.worker_id
      WHERE ${where}
      ${order}
      LIMIT ${limit}
    `)) as unknown as Record<string, unknown>[];
    return rows.map(toView);
  }
}

/** When Campus must learn of a change: the Campus record's own change or the company's stage. */
const CHANGED_AT = sql`GREATEST(ia.updated_at, COALESCE(s.updated_at, ia.updated_at))`;

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toView(r: Record<string, unknown>): CampusApplicationView {
  return {
    id: String(r.id),
    instituteCode: r.institute_code as InstituteCode,
    externalRef: String(r.external_ref),
    applicationId: (r.application_id as string | null) ?? null,
    jobPostingId: String(r.job_posting_id),
    workerId: String(r.worker_id),
    campusAppliedAt: r.campus_applied_at === null ? null : toDate(r.campus_applied_at),
    withdrawnAt: r.withdrawn_at === null ? null : toDate(r.withdrawn_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    studentRef: (r.student_ref as string | null) ?? null,
    stage: (r.stage as ApplicantStage | null) ?? null,
    changedAt: toDate(r.changed_at),
  };
}

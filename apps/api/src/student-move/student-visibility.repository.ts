import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql, type SQL } from "drizzle-orm";
import { auditLogs, type Database } from "@badabhai/db";
import type { EntityCursor } from "../admin/admin-entities.cursor";
import { DATABASE } from "../database/database.module";

/** One moved student as the admin list shows him. Ids, a flag, reference labels and times. */
export interface MovedStudentRow {
  workerId: string;
  visible: boolean;
  batchId: string | null;
  branch: string | null;
  course: string | null;
  changedAt: Date;
  createdAt: Date;
}

/** How a bulk change chooses its students. */
export type StudentSelector =
  | { readonly kind: "batch"; readonly batchId: string }
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "course"; readonly course: string };

/**
 * Data access for `student_visibility` (#2887). Used only while STUDENT_MOVE_ENABLED is on; the
 * service answers 503 when the table is missing (42P01).
 *
 * Branch and course come from the student's ACTIVE #2752 link (`worker_institute_links`), the
 * one place BadaBhai stores them; a moved student with no link row has neither.
 */
@Injectable()
export class StudentVisibilityRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx as unknown as Database));
  }

  /** One page of moved students, newest first (`created_at`, `worker_id` DESC). */
  async list(filter: {
    batchId?: string;
    visible?: boolean;
    branch?: string;
    course?: string;
    after: EntityCursor | null;
    limit: number;
  }): Promise<MovedStudentRow[]> {
    const where: SQL[] = [dsql`TRUE`];
    if (filter.batchId !== undefined) where.push(dsql`sv.batch_id = ${filter.batchId}::uuid`);
    if (filter.visible !== undefined) where.push(dsql`sv.visible = ${filter.visible}`);
    if (filter.branch !== undefined) where.push(dsql`il.branch = ${filter.branch}`);
    if (filter.course !== undefined) where.push(dsql`il.course = ${filter.course}`);
    if (filter.after) {
      where.push(dsql`(sv.created_at, sv.worker_id) < (${filter.after.createdAt}::timestamptz, ${filter.after.id}::uuid)`);
    }
    const rows = (await this.db.execute(dsql`
      SELECT sv.worker_id, sv.visible, sv.batch_id, il.branch, il.course, sv.changed_at,
             sv.created_at
      FROM student_visibility sv
      LEFT JOIN worker_institute_links il
        ON il.worker_id = sv.worker_id AND il.status = 'active'
      WHERE ${dsql.join(where, dsql` AND `)}
      ORDER BY sv.created_at DESC, sv.worker_id DESC
      LIMIT ${filter.limit}
    `)) as unknown as Record<string, unknown>[];
    return rows.map(toRow);
  }

  /** One moved student's row, or undefined for a worker who was never moved. */
  async findOne(workerId: string, executor: Database = this.db): Promise<MovedStudentRow | undefined> {
    const rows = (await executor.execute(dsql`
      SELECT sv.worker_id, sv.visible, sv.batch_id, il.branch, il.course, sv.changed_at,
             sv.created_at
      FROM student_visibility sv
      LEFT JOIN worker_institute_links il
        ON il.worker_id = sv.worker_id AND il.status = 'active'
      WHERE sv.worker_id = ${workerId}::uuid
    `)) as unknown as Record<string, unknown>[];
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  /**
   * Set the visibility of the selected moved students. Only rows whose state CHANGES are written,
   * so a repeat is a no-op. Returns the ids that changed.
   */
  async set(
    tx: Database,
    selector: StudentSelector | { readonly kind: "worker"; readonly workerId: string },
    change: { readonly visible: boolean; readonly adminId: string; readonly reason: string },
  ): Promise<string[]> {
    const chosen = selectorClause(selector);
    const rows = (await tx.execute(dsql`
      UPDATE student_visibility sv
      SET visible = ${change.visible},
          changed_by_admin_id = ${change.adminId}::uuid,
          reason = ${change.reason},
          changed_at = now()
      WHERE sv.visible <> ${change.visible}
        AND ${chosen}
      RETURNING sv.worker_id
    `)) as unknown as { worker_id: string }[];
    return rows.map((r) => String(r.worker_id));
  }

  /** The admin route's audit row, in the change's own transaction. */
  async audit(
    tx: Database,
    entry: {
      adminId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: entry.adminId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata,
    });
  }
}

function selectorClause(
  selector: StudentSelector | { readonly kind: "worker"; readonly workerId: string },
): SQL {
  switch (selector.kind) {
    case "worker":
      return dsql`sv.worker_id = ${selector.workerId}::uuid`;
    case "batch":
      return dsql`sv.batch_id = ${selector.batchId}::uuid`;
    case "branch":
      return dsql`EXISTS (
        SELECT 1 FROM worker_institute_links il
        WHERE il.worker_id = sv.worker_id AND il.status = 'active' AND il.branch = ${selector.branch}
      )`;
    case "course":
      return dsql`EXISTS (
        SELECT 1 FROM worker_institute_links il
        WHERE il.worker_id = sv.worker_id AND il.status = 'active' AND il.course = ${selector.course}
      )`;
  }
}

function toRow(r: Record<string, unknown>): MovedStudentRow {
  return {
    workerId: String(r.worker_id),
    visible: r.visible === true,
    batchId: typeof r.batch_id === "string" ? r.batch_id : null,
    branch: typeof r.branch === "string" ? r.branch : null,
    course: typeof r.course === "string" ? r.course : null,
    changedAt: new Date(r.changed_at as string | Date),
    createdAt: new Date(r.created_at as string | Date),
  };
}

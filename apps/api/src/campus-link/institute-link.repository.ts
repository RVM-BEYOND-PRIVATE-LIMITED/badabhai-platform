import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLogs,
  workerInstituteLinks,
  workerOrigins,
  workers,
  type Database,
  type InstituteCode,
  type InstituteStudentStatus,
  type WorkerOriginKind,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

export type InstituteLinkRow = typeof workerInstituteLinks.$inferSelect;

/** The agreed facts a successful Student API read refreshes on the link row. */
export interface InstituteLinkFacts {
  studentStatus: InstituteStudentStatus;
  course: string;
  branch: string;
  /** numeric(5,2) travels as text. */
  testScore: string | null;
}

/** The `audit_logs.action` values the link writes for the manual list. */
export const INSTITUTE_LINK_AUDIT_ACTIONS = {
  phoneMismatch: "institute_link.phone_mismatch",
  refused: "institute_link.refused",
} as const;

/**
 * Data access for the institute student link (#2752 part B). Every method takes the caller's
 * transaction, so a link, the worker row behind it and its event commit together.
 */
@Injectable()
export class InstituteLinkRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** The link for one institute student, locked for this transaction. */
  async findByRefForUpdate(
    tx: Database,
    instituteCode: InstituteCode,
    studentRef: string,
  ): Promise<InstituteLinkRow | undefined> {
    const rows = await tx
      .select()
      .from(workerInstituteLinks)
      .where(
        and(
          eq(workerInstituteLinks.instituteCode, instituteCode),
          eq(workerInstituteLinks.studentRef, studentRef),
        ),
      )
      .for("update")
      .limit(1);
    return rows[0];
  }

  /** Inserts an active link; undefined when the worker or the reference is already linked. */
  async insertActive(
    tx: Database,
    row: {
      workerId: string;
      instituteCode: InstituteCode;
      studentRef: string;
      facts: InstituteLinkFacts;
      now: Date;
    },
  ): Promise<InstituteLinkRow | undefined> {
    const inserted = await tx
      .insert(workerInstituteLinks)
      .values({
        workerId: row.workerId,
        instituteCode: row.instituteCode,
        studentRef: row.studentRef,
        status: "active",
        ...row.facts,
        linkedAt: row.now,
        syncedAt: row.now,
      })
      .onConflictDoNothing()
      .returning();
    return inserted[0];
  }

  /** A successful read: refresh the facts and (re)activate the link. */
  async refreshActive(
    tx: Database,
    workerId: string,
    facts: InstituteLinkFacts,
    now: Date,
  ): Promise<void> {
    await tx
      .update(workerInstituteLinks)
      .set({ ...facts, status: "active", withdrawnAt: null, syncedAt: now })
      .where(eq(workerInstituteLinks.workerId, workerId));
  }

  /** First touch wins: an origin already recorded is never overwritten. */
  async recordOrigin(
    tx: Database,
    workerId: string,
    kind: WorkerOriginKind,
    ref: string,
  ): Promise<void> {
    await tx.insert(workerOrigins).values({ workerId, kind, ref }).onConflictDoNothing();
  }

  /** Sets the encrypted name only where the worker has none: his own name is never replaced. */
  async setNameIfMissing(tx: Database, workerId: string, fullNameEnc: string): Promise<void> {
    await tx
      .update(workers)
      .set({ fullName: fullNameEnc, updatedAt: new Date() })
      .where(and(eq(workers.id, workerId), isNull(workers.fullName)));
  }

  /**
   * Moves a link-created row to a new phone. Only a `pending` row (no sign-in yet) moves: the
   * phone of a worker who signs in himself is his login and is never changed from here.
   * Returns false when the row is not pending.
   */
  async movePendingWorkerPhone(
    tx: Database,
    workerId: string,
    phone: { phoneE164Enc: string; phoneHash: string },
  ): Promise<boolean> {
    const rows = await tx
      .update(workers)
      .set({ phoneE164: phone.phoneE164Enc, phoneHash: phone.phoneHash, updatedAt: new Date() })
      .where(and(eq(workers.id, workerId), eq(workers.status, "pending")))
      .returning({ id: workers.id });
    return rows.length > 0;
  }

  /** A case for the manual list. Ids and a reason code only: no phone, no name. */
  async recordManualCase(
    tx: Database,
    action: (typeof INSTITUTE_LINK_AUDIT_ACTIONS)[keyof typeof INSTITUTE_LINK_AUDIT_ACTIONS],
    workerId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorId: null,
      action,
      entityType: "worker",
      entityId: workerId,
      metadata,
    });
  }
}

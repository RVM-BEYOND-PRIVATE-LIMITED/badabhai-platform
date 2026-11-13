import { Inject, Injectable } from "@nestjs/common";
import { and, eq, exists, sql } from "drizzle-orm";
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

  /**
   * Serialises every link of one institute student for the rest of this transaction, so two
   * concurrent calls for the same reference cannot both create a worker row (the second waits and
   * then finds the first one's link).
   */
  async lockStudentRef(
    tx: Database,
    instituteCode: InstituteCode,
    studentRef: string,
  ): Promise<void> {
    const key = `institute_link:${instituteCode}:${studentRef}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
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

  /** The two worker facts that decide whether a link may stand: suspended, or being deleted. */
  async workerStanding(
    tx: Database,
    workerId: string,
  ): Promise<{ status: string; deletionScheduledAt: Date | null } | undefined> {
    const rows = await tx
      .select({ status: workers.status, deletionScheduledAt: workers.deletionScheduledAt })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    return rows[0];
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

  /**
   * Moves a row THIS INSTITUTE'S LINK CREATED to a new phone. Both conditions are required: the
   * row is still `pending` (its first sign-in activates it) AND its origin is this institute (the
   * link made it). A legacy `pending` row, or any row a person signs in to himself, never moves:
   * its phone is a login. Returns false when nothing moved.
   */
  async moveLinkCreatedWorkerPhone(
    tx: Database,
    workerId: string,
    instituteCode: InstituteCode,
    phone: { phoneE164Enc: string; phoneHash: string },
  ): Promise<boolean> {
    const rows = await tx
      .update(workers)
      .set({ phoneE164: phone.phoneE164Enc, phoneHash: phone.phoneHash, updatedAt: new Date() })
      .where(
        and(
          eq(workers.id, workerId),
          eq(workers.status, "pending"),
          exists(
            tx
              .select({ one: sql`1` })
              .from(workerOrigins)
              .where(
                and(
                  eq(workerOrigins.workerId, workerId),
                  eq(workerOrigins.kind, "institute"),
                  eq(workerOrigins.ref, instituteCode),
                ),
              ),
          ),
        ),
      )
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

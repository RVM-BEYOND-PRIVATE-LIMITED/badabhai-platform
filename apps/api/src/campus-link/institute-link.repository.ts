import { Inject, Injectable } from "@nestjs/common";
import { and, eq, exists, notExists, or, sql } from "drizzle-orm";
import {
  applications,
  auditLogs,
  jobPostings,
  jobs,
  unlocks,
  workerConsents,
  workerCredentials,
  workerDevices,
  workerInstituteLinks,
  workerOrigins,
  workers,
  type Database,
  type InstituteCode,
  type InstituteStudentStatus,
  type WorkerOriginKind,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";

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

  /**
   * His live link, or undefined. On the global pool: the open gate reads it before the unlock's
   * advisory lock, beside the consent read it stands in for (the pool-vs-lock deadlock rule).
   */
  async findActiveByWorker(workerId: string): Promise<InstituteLinkRow | undefined> {
    const rows = await this.db
      .select()
      .from(workerInstituteLinks)
      .where(
        and(eq(workerInstituteLinks.workerId, workerId), eq(workerInstituteLinks.status, "active")),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Whether he applied to a posting or a legacy job this tenant owns: the institute rule's "a
   * company he applied to". Ownership is `payer_id` = the tenant key, as `findOwnedJobRef` reads
   * it. Any apply counts, through Campus or the worker app, whatever its stage since.
   */
  async hasAppliedToTenant(workerId: string, tenant: TenantKey): Promise<boolean> {
    const rows = await this.db
      .select({ id: applications.id })
      .from(applications)
      .leftJoin(jobPostings, eq(jobPostings.id, applications.jobPostingId))
      .leftJoin(jobs, eq(jobs.id, applications.jobId))
      .where(
        and(
          eq(applications.workerId, workerId),
          eq(applications.action, "applied"),
          or(eq(jobPostings.payerId, tenant), eq(jobs.payerId, tenant)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The same question for the company that HOLDS an unlock: the reveal's subject, on the payer
   * route and the ops route alike. The holder is `unlocks.payer_id` (the tenant key the grant was
   * made under), joined here in SQL, so no raw payer id is passed around (ADR-0053 T5).
   */
  async hasAppliedToUnlockHolder(workerId: string, unlockId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: applications.id })
      .from(unlocks)
      .innerJoin(applications, eq(applications.workerId, unlocks.workerId))
      .leftJoin(jobPostings, eq(jobPostings.id, applications.jobPostingId))
      .leftJoin(jobs, eq(jobs.id, applications.jobId))
      .where(
        and(
          eq(unlocks.id, unlockId),
          eq(unlocks.workerId, workerId),
          eq(applications.action, "applied"),
          or(eq(jobPostings.payerId, unlocks.payerId), eq(jobs.payerId, unlocks.payerId)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * RVM confirmed his consent again: refresh the facts and the confirmation time. Only an active
   * link moves; one withdrawn since the read stays withdrawn, and the answer is then false, so a
   * caller never opens on a confirmation that did not land.
   */
  async confirmActive(workerId: string, facts: InstituteLinkFacts, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(workerInstituteLinks)
      .set({ ...facts, syncedAt: now })
      .where(
        and(eq(workerInstituteLinks.workerId, workerId), eq(workerInstituteLinks.status, "active")),
      )
      .returning({ workerId: workerInstituteLinks.workerId });
    return rows.length > 0;
  }

  /**
   * Deletes the worker row THIS INSTITUTE'S LINK CREATED, when he has never used it as a BadaBhai
   * account. `pending` alone does not prove that (a PIN reset mints a session without activating
   * the row), so every trace of an account must be absent too:
   *   - still `pending`, and its origin this institute (the link made it);
   *   - no `worker_consents` row: he never accepted BadaBhai's notice, so he never used the app;
   *   - no `worker_credentials` row (no PIN) and no `worker_devices` row (no trusted device).
   * One conditional statement, so a sign-in that leaves any of those first keeps the row. Postgres
   * cascades his link, origin and applications and sets his billing rows' worker to null, as the
   * DPDP erasure's own delete does; with no account there are no sessions, files or transcripts
   * for `AccountDeletionService` to sweep. False when nothing was deleted.
   */
  async deleteLinkCreatedPendingWorker(
    tx: Database,
    workerId: string,
    instituteCode: InstituteCode,
  ): Promise<boolean> {
    const rows = await tx
      .delete(workers)
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
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workerConsents)
              .where(eq(workerConsents.workerId, workerId)),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workerCredentials)
              .where(eq(workerCredentials.workerId, workerId)),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workerDevices)
              .where(eq(workerDevices.workerId, workerId)),
          ),
        ),
      )
      .returning({ id: workers.id });
    return rows.length > 0;
  }

  /**
   * Withdraws the link and erases everything copied from the institute. The reference stays, so a
   * repeated unlink finds the link already withdrawn and a re-link (he consents again) reuses it.
   */
  async withdrawAndErase(tx: Database, workerId: string, now: Date): Promise<void> {
    await tx
      .update(workerInstituteLinks)
      .set({
        status: "withdrawn",
        withdrawnAt: now,
        studentStatus: null,
        course: null,
        branch: null,
        testScore: null,
        consentVersion: null,
        consentAt: null,
      })
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

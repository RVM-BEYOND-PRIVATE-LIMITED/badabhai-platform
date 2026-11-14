import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  instituteSearchGrants,
  payers,
  workerInstituteLinks,
  type Database,
  type InstituteCode,
  type InstituteSearchGrantRow,
  type PayerStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";

/** A grant with the student reference of the link behind it (null once he was unlinked). */
export type InstituteSearchGrantView = InstituteSearchGrantRow & { studentRef: string | null };

/**
 * Data access for named-company search grants (#2752 item 10). Every write takes the caller's
 * transaction, so a grant and its event commit together.
 */
@Injectable()
export class InstituteSearchGrantsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** Serialises every write of one Campus grant ref for the rest of this transaction. */
  async lockRef(tx: Database, instituteCode: InstituteCode, grantRef: string): Promise<void> {
    const key = `institute_search_grant:${instituteCode}:${grantRef}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  /** The grant Campus knows by this ref, with the student ref behind it. */
  async findByRef(
    instituteCode: InstituteCode,
    grantRef: string,
    tx: Database = this.db,
  ): Promise<InstituteSearchGrantView | undefined> {
    const rows = await tx
      .select({ grant: instituteSearchGrants, studentRef: workerInstituteLinks.studentRef })
      .from(instituteSearchGrants)
      .leftJoin(
        workerInstituteLinks,
        eq(workerInstituteLinks.workerId, instituteSearchGrants.workerId),
      )
      .where(
        and(
          eq(instituteSearchGrants.instituteCode, instituteCode),
          eq(instituteSearchGrants.grantRef, grantRef),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { ...row.grant, studentRef: row.studentRef } : undefined;
  }

  /**
   * The company Campus names, if it exists: its lifecycle status only (the caller refuses a barred
   * one). Read by primary key; no name, email or phone.
   */
  async companyStatus(companyId: string): Promise<PayerStatus | undefined> {
    const rows = await this.db
      .select({ status: payers.status })
      .from(payers)
      .where(eq(payers.id, companyId))
      .limit(1);
    return rows[0]?.status;
  }

  /** Stores a live grant; undefined when the ref, or a live grant for the pair, already exists. */
  async insertLive(
    tx: Database,
    row: {
      instituteCode: InstituteCode;
      grantRef: string;
      tenant: TenantKey;
      workerId: string;
      consentRef: string;
      skillId: string | null;
      industryId: string | null;
      now: Date;
    },
  ): Promise<InstituteSearchGrantRow | undefined> {
    const inserted = await tx
      .insert(instituteSearchGrants)
      .values({
        instituteCode: row.instituteCode,
        grantRef: row.grantRef,
        payerId: row.tenant,
        workerId: row.workerId,
        consentRef: row.consentRef,
        skillId: row.skillId,
        industryId: row.industryId,
        grantedAt: row.now,
      })
      .onConflictDoNothing()
      .returning();
    return inserted[0];
  }

  /** The live grant this company holds for this worker, if any. */
  async findLive(
    tx: Database,
    tenant: TenantKey,
    workerId: string,
    instituteCode: InstituteCode,
  ): Promise<InstituteSearchGrantRow | undefined> {
    const rows = await tx
      .select()
      .from(instituteSearchGrants)
      .where(
        and(
          eq(instituteSearchGrants.payerId, tenant),
          eq(instituteSearchGrants.workerId, workerId),
          eq(instituteSearchGrants.instituteCode, instituteCode),
          isNull(instituteSearchGrants.revokedAt),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Whether this consent ref already granted this company this worker (a grant since revoked). */
  async consentRefSpent(
    tx: Database,
    tenant: TenantKey,
    workerId: string,
    consentRef: string,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: instituteSearchGrants.id })
      .from(instituteSearchGrants)
      .where(
        and(
          eq(instituteSearchGrants.payerId, tenant),
          eq(instituteSearchGrants.workerId, workerId),
          eq(instituteSearchGrants.consentRef, consentRef),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Revokes one grant by id; a grant already revoked keeps its first revocation time. */
  async revoke(tx: Database, id: string, now: Date): Promise<InstituteSearchGrantRow | undefined> {
    const rows = await tx
      .update(instituteSearchGrants)
      .set({ revokedAt: now })
      .where(and(eq(instituteSearchGrants.id, id), isNull(instituteSearchGrants.revokedAt)))
      .returning();
    return rows[0];
  }
}

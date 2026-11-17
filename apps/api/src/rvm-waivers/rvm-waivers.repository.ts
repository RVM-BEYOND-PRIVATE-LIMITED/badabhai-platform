import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  adminUsers,
  applications,
  auditLogs,
  jobPostings,
  jobs,
  payers,
  rvmApplicantWaivers,
  rvmWaiverUses,
  type Database,
  type PayerStatus,
  type RvmApplicantWaiverRow,
  type RvmWaiverScope,
  type RvmWaiverSource,
} from "@badabhai/db";
import { sqlStateOf } from "../common/db-error";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { EntityCursor } from "../admin/admin-entities.cursor";

/** One waiver row with the number of opens it paid for. */
export interface RvmWaiverWithUses extends RvmApplicantWaiverRow {
  waivedOpens: number;
}

/** A new waiver, as {@link RvmWaiversRepository.insert} writes it. */
export interface NewRvmWaiver {
  scope: RvmWaiverScope;
  tenant: TenantKey;
  jobPostingId: string | null;
  source: RvmWaiverSource;
  setByRef: string;
  setByLabelEnc: string | null;
  reason: string;
}

/** Who cleared a waiver, and why. */
export interface RvmWaiverClear {
  clearedByRef: string;
  clearedByLabelEnc: string | null;
  clearReason: string;
  at: Date;
}

/** The waiver that frees one worker for one company, when one does. */
export interface WaiverMatch {
  waiverId: string;
  scope: RvmWaiverScope;
}

/** Postgres "undefined_table": the migration is not applied yet. */
const UNDEFINED_TABLE = "42P01";

/**
 * Data access for `rvm_applicant_waivers` and `rvm_waiver_uses` (#2750 item 5). The only reader
 * and writer of both tables.
 *
 * TWO KINDS OF READ. The waiver routes ({@link RvmWaiversService}) read and write under the
 * `credit_rules` switch, and a missing table there is a 503. The PRICE read
 * ({@link waiversFor}), made on every open and quote under the credit rules, treats a missing
 * table as "no waiver" (logged once with its SQLSTATE): a deploy ahead of the migration then
 * prices exactly as before this change, rather than refusing every open.
 */
@Injectable()
export class RvmWaiversRepository {
  private readonly logger = new Logger(RvmWaiversRepository.name);
  private warnedMissingTable = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx as unknown as Database));
  }

  /** The account's status, or undefined for no such payer. */
  async companyStatus(companyId: string): Promise<PayerStatus | undefined> {
    const rows = await this.db
      .select({ status: payers.status })
      .from(payers)
      .where(eq(payers.id, companyId))
      .limit(1);
    return rows[0]?.status;
  }

  /** The posting's owner (`job_postings.payer_id`, the tenant key), or undefined for none. */
  async postingOwner(postingId: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ payerId: jobPostings.payerId })
      .from(jobPostings)
      .where(eq(jobPostings.id, postingId))
      .limit(1);
    return rows[0]?.payerId ?? undefined;
  }

  /** The admin's stored name, still encrypted (copied as is onto the waiver), or null. */
  async adminNameEnc(adminId: string): Promise<string | null> {
    const rows = await this.db
      .select({ nameEnc: adminUsers.nameEnc })
      .from(adminUsers)
      .where(eq(adminUsers.id, adminId))
      .limit(1);
    return rows[0]?.nameEnc ?? null;
  }

  /**
   * Serialise every change of ONE scope (a company's company waiver, or a job's waiver) for the
   * rest of the transaction, so a set and a clear racing on it apply one after the other. The
   * partial unique indexes are the backstop.
   */
  async lockScope(tx: Database, scope: RvmWaiverScope, key: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`rvm_waiver:${scope}:${key}`}, 0))`,
    );
  }

  /** The ACTIVE waiver of one scope, or undefined. */
  async findActive(
    tx: Database,
    scope: RvmWaiverScope,
    tenant: TenantKey,
    jobPostingId: string | null,
  ): Promise<RvmApplicantWaiverRow | undefined> {
    const rows = await tx
      .select()
      .from(rvmApplicantWaivers)
      .where(
        and(
          eq(rvmApplicantWaivers.active, true),
          eq(rvmApplicantWaivers.scope, scope),
          eq(rvmApplicantWaivers.payerId, tenant),
          scope === "job" && jobPostingId !== null
            ? eq(rvmApplicantWaivers.jobPostingId, jobPostingId)
            : undefined,
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The newest waiver of one scope, active or cleared, or undefined for none ever. */
  async findLatest(
    tx: Database,
    scope: RvmWaiverScope,
    tenant: TenantKey,
    jobPostingId: string | null,
  ): Promise<RvmApplicantWaiverRow | undefined> {
    const rows = await tx
      .select()
      .from(rvmApplicantWaivers)
      .where(
        and(
          eq(rvmApplicantWaivers.scope, scope),
          eq(rvmApplicantWaivers.payerId, tenant),
          scope === "job" && jobPostingId !== null
            ? eq(rvmApplicantWaivers.jobPostingId, jobPostingId)
            : undefined,
        ),
      )
      .orderBy(desc(rvmApplicantWaivers.createdAt), desc(rvmApplicantWaivers.id))
      .limit(1);
    return rows[0];
  }

  async insert(tx: Database, row: NewRvmWaiver): Promise<RvmApplicantWaiverRow> {
    const [inserted] = await tx
      .insert(rvmApplicantWaivers)
      .values({
        scope: row.scope,
        payerId: row.tenant,
        jobPostingId: row.jobPostingId,
        active: true,
        source: row.source,
        setByRef: row.setByRef,
        setByLabelEnc: row.setByLabelEnc,
        reason: row.reason,
      })
      .returning();
    if (!inserted) throw new Error("rvm_applicant_waivers: the waiver was not written");
    return inserted;
  }

  /** Clears an ACTIVE waiver; undefined when it was no longer active. */
  async clear(
    tx: Database,
    waiverId: string,
    clear: RvmWaiverClear,
  ): Promise<RvmApplicantWaiverRow | undefined> {
    const [row] = await tx
      .update(rvmApplicantWaivers)
      .set({
        active: false,
        clearedAt: clear.at,
        clearedByRef: clear.clearedByRef,
        clearedByLabelEnc: clear.clearedByLabelEnc,
        clearReason: clear.clearReason,
      })
      .where(and(eq(rvmApplicantWaivers.id, waiverId), eq(rvmApplicantWaivers.active, true)))
      .returning();
    return row;
  }

  /** The admin route's audit row, in the change's own transaction. */
  async audit(
    tx: Database,
    entry: { adminId: string; action: string; waiverId: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: entry.adminId,
      action: entry.action,
      entityType: "rvm_applicant_waiver",
      entityId: entry.waiverId,
      metadata: entry.metadata,
    });
  }

  /** How many opens each waiver paid for. */
  async usesOf(waiverIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (waiverIds.length === 0) return out;
    const rows = await this.db
      .select({ waiverId: rvmWaiverUses.waiverId, n: count() })
      .from(rvmWaiverUses)
      .where(inArray(rvmWaiverUses.waiverId, [...waiverIds]))
      .groupBy(rvmWaiverUses.waiverId);
    for (const r of rows) out.set(r.waiverId, Number(r.n));
    return out;
  }

  /**
   * One page of waivers, newest first (`created_at`, `id` DESC). Active only unless
   * `includeCleared`; one company's only when `tenant` is given.
   */
  async list(filter: {
    tenant?: TenantKey;
    includeCleared: boolean;
    after: EntityCursor | null;
    limit: number;
  }): Promise<RvmWaiverWithUses[]> {
    const rows = await this.db
      .select()
      .from(rvmApplicantWaivers)
      .where(
        and(
          filter.includeCleared ? undefined : eq(rvmApplicantWaivers.active, true),
          filter.tenant ? eq(rvmApplicantWaivers.payerId, filter.tenant) : undefined,
          filter.after
            ? or(
                lt(rvmApplicantWaivers.createdAt, new Date(filter.after.createdAt)),
                and(
                  eq(rvmApplicantWaivers.createdAt, new Date(filter.after.createdAt)),
                  lt(rvmApplicantWaivers.id, filter.after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(rvmApplicantWaivers.createdAt), desc(rvmApplicantWaivers.id))
      .limit(filter.limit);
    const uses = await this.usesOf(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, waivedOpens: uses.get(r.id) ?? 0 }));
  }

  /**
   * #2750 item 5 — the waiver that frees each worker for THIS company, for a page of workers (the
   * quote) or one (the open). A worker is freed when he APPLIED (`applications.action = 'applied'`)
   * to:
   *   - a posting of this company that has an active JOB waiver, or
   *   - any posting or legacy job of this company, while the company has an active COMPANY waiver.
   * A job waiver wins over a company waiver (the narrower one is the one recorded as used). Whether
   * he is an RVM student is the cost rule's question, not this read's.
   *
   * Applications are already on the company's own applicant list, and the waiver is the company's
   * own, so the answer is a fact on the card (#2750 private notes item 5).
   *
   * A missing table (the migration not applied yet) reads as no waiver, logged once.
   */
  async waiversFor(
    tenant: TenantKey,
    workerIds: readonly string[],
  ): Promise<Map<string, WaiverMatch>> {
    const out = new Map<string, WaiverMatch>();
    if (workerIds.length === 0) return out;
    const ids = [...workerIds];
    try {
      const viaPostings = await this.db
        .select({
          workerId: applications.workerId,
          waiverId: rvmApplicantWaivers.id,
          scope: rvmApplicantWaivers.scope,
        })
        .from(applications)
        .innerJoin(jobPostings, eq(jobPostings.id, applications.jobPostingId))
        .innerJoin(
          rvmApplicantWaivers,
          and(
            eq(rvmApplicantWaivers.active, true),
            eq(rvmApplicantWaivers.payerId, tenant),
            or(
              and(
                eq(rvmApplicantWaivers.scope, "job"),
                eq(rvmApplicantWaivers.jobPostingId, applications.jobPostingId),
              ),
              eq(rvmApplicantWaivers.scope, "company"),
            ),
          ),
        )
        .where(
          and(
            inArray(applications.workerId, ids),
            eq(applications.action, "applied"),
            eq(jobPostings.payerId, tenant),
          ),
        );
      const viaLegacyJobs = await this.db
        .select({
          workerId: applications.workerId,
          waiverId: rvmApplicantWaivers.id,
          scope: rvmApplicantWaivers.scope,
        })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .innerJoin(
          rvmApplicantWaivers,
          and(
            eq(rvmApplicantWaivers.active, true),
            eq(rvmApplicantWaivers.payerId, tenant),
            eq(rvmApplicantWaivers.scope, "company"),
          ),
        )
        .where(
          and(
            inArray(applications.workerId, ids),
            eq(applications.action, "applied"),
            eq(jobs.payerId, tenant),
          ),
        );
      for (const m of [...viaPostings, ...viaLegacyJobs]) {
        const held = out.get(m.workerId);
        if (held === undefined || (held.scope === "company" && m.scope === "job")) {
          out.set(m.workerId, { waiverId: m.waiverId, scope: m.scope });
        }
      }
      return out;
    } catch (err) {
      if (sqlStateOf(err) !== UNDEFINED_TABLE) throw err;
      if (!this.warnedMissingTable) {
        this.warnedMissingTable = true;
        this.logger.warn(
          `rvm_applicant_waivers missing (sqlstate=${UNDEFINED_TABLE}); pricing as if no waiver existed until the migration is applied`,
        );
      }
      return out;
    }
  }

  /**
   * Inside the open's transaction: is the waiver STILL active? Read `FOR SHARE`, so a clear racing
   * this open waits for it to commit (and the use row below names a waiver that was live).
   */
  async isActiveForShare(tx: Database, waiverId: string): Promise<boolean> {
    const rows = await tx
      .select({ active: rvmApplicantWaivers.active })
      .from(rvmApplicantWaivers)
      .where(eq(rvmApplicantWaivers.id, waiverId))
      .for("share");
    return rows[0]?.active === true;
  }

  /** The open this waiver paid for, in the open's own transaction. */
  async recordUse(
    tx: Database,
    use: { waiverId: string; unlockId: string; tenant: TenantKey },
  ): Promise<void> {
    await tx
      .insert(rvmWaiverUses)
      .values({ waiverId: use.waiverId, unlockId: use.unlockId, payerId: use.tenant });
  }
}

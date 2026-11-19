import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  adminUsers,
  applications,
  auditLogs,
  jobPostings,
  jobs,
  payers,
  rvmApplicantWaivers,
  rvmWaiverEndDates,
  rvmWaiverUses,
  type Database,
  type PayerStatus,
  type RvmApplicantWaiverRow,
  type RvmWaiverScope,
  type RvmWaiverSource,
} from "@badabhai/db";
import { sqlStateOf } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { EntityCursor } from "../admin/admin-entities.cursor";

/** A waiver's end date (#2778): the last day it applies, and whether that day has passed. */
export interface RvmWaiverEnd {
  /** `YYYY-MM-DD`, the last day (India time) the waiver applies. */
  endsOn: string;
  /** True from the day after `endsOn` (India time, by the database clock): it frees nobody. */
  ended: boolean;
}

/** One waiver row with the number of opens it paid for, and its end date (#2778) if any. */
export interface RvmWaiverWithUses extends RvmApplicantWaiverRow {
  waivedOpens: number;
  /** Null when the waiver has no end date, or end dates are switched off. */
  end: RvmWaiverEnd | null;
}

/** The one config key the end dates read (#2778). */
export type RvmWaiverEndDatesConfig = Partial<Pick<ServerConfig, "RVM_WAIVER_END_DATES_ENABLED">>;

/** Today in India, by the database clock: the day both the quote and the open compare against. */
const TODAY_IST = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * #2778 — "this waiver's end date has not passed": no end date, or its last day is today or later
 * (India time). Named only while end dates are on and their table is present.
 */
const NOT_ENDED = sql`NOT EXISTS (SELECT 1 FROM ${rvmWaiverEndDates} WHERE ${rvmWaiverEndDates.waiverId} = ${rvmApplicantWaivers.id} AND ${rvmWaiverEndDates.endsOn} < ${TODAY_IST})`;

/** How long a "the end-date table is missing" answer is trusted before asking again. */
const END_DATES_MISSING_RECHECK_MS = 60_000;

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
 *
 * END DATES (#2778, `rvm_waiver_end_dates`). Only while `RVM_WAIVER_END_DATES_ENABLED` is on AND
 * the table is present ({@link endDatesReadable}) do the price reads ({@link waiversFor},
 * {@link isActiveForShare}) and the in-force list add "its end date has not passed", against the
 * database's own clock in India time, so the quote and the open can never disagree. Off, or the
 * table missing, every statement here is the one it was before #2778, and no waiver has an end.
 */
@Injectable()
export class RvmWaiversRepository {
  private readonly logger = new Logger(RvmWaiversRepository.name);
  private warnedMissingTable = false;
  /** #2778 — RVM_WAIVER_END_DATES_ENABLED, read once. Off (or no config at all) is today. */
  readonly endDatesEnabled: boolean;
  /** #2778 — true once the table was seen (it is never dropped while on); else when last missing. */
  private endDatesPresent = false;
  private endDatesMissingAtMs: number | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // Optional only so the hand-built instances keep compiling; absent reads as off.
    @Optional() @Inject(SERVER_CONFIG) config?: RvmWaiverEndDatesConfig,
  ) {
    this.endDatesEnabled = config?.RVM_WAIVER_END_DATES_ENABLED === true;
  }

  /**
   * #2778 — may end dates be read and written? Only with the switch on and `rvm_waiver_end_dates`
   * present (checked with `to_regclass`, which never errors, so it is safe inside the open's
   * transaction). The switch on before the migration reads as off, logged once.
   */
  async endDatesReadable(executor: Pick<Database, "execute"> = this.db): Promise<boolean> {
    if (!this.endDatesEnabled) return false;
    if (this.endDatesPresent) return true;
    if (
      this.endDatesMissingAtMs !== null &&
      Date.now() - this.endDatesMissingAtMs < END_DATES_MISSING_RECHECK_MS
    ) {
      return false;
    }
    const rows = (await executor.execute(
      sql`SELECT to_regclass('public.rvm_waiver_end_dates') IS NOT NULL AS present`,
    )) as unknown as { present?: unknown }[];
    if (rows[0]?.present === true) {
      this.endDatesPresent = true;
      return true;
    }
    if (this.endDatesMissingAtMs === null) {
      this.logger.warn(
        "rvm_waiver_end_dates missing with RVM_WAIVER_END_DATES_ENABLED on: waivers run until cleared " +
          "and a dated set answers 503 until the rvm_waiver_end_dates migration is applied",
      );
    }
    this.endDatesMissingAtMs = Date.now();
    return false;
  }

  /**
   * #2778 — the end date of each waiver that has one, and whether it has passed (by the database
   * clock, India time). Empty while end dates are off or their table is missing.
   */
  async endsOf(
    waiverIds: readonly string[],
    executor: Database = this.db,
  ): Promise<Map<string, RvmWaiverEnd>> {
    const out = new Map<string, RvmWaiverEnd>();
    if (waiverIds.length === 0 || !(await this.endDatesReadable(executor))) return out;
    const rows = await executor
      .select({
        waiverId: rvmWaiverEndDates.waiverId,
        endsOn: rvmWaiverEndDates.endsOn,
        ended: sql<boolean>`${rvmWaiverEndDates.endsOn} < ${TODAY_IST}`,
      })
      .from(rvmWaiverEndDates)
      .where(inArray(rvmWaiverEndDates.waiverId, [...waiverIds]));
    for (const r of rows) out.set(r.waiverId, { endsOn: r.endsOn, ended: r.ended === true });
    return out;
  }

  /** #2778 — a new waiver's end date, in the transaction that sets it. Written once, never changed. */
  async insertEndDate(
    tx: Database,
    row: { waiverId: string; tenant: TenantKey; endsOn: string },
  ): Promise<void> {
    await tx
      .insert(rvmWaiverEndDates)
      .values({ waiverId: row.waiverId, payerId: row.tenant, endsOn: row.endsOn });
  }

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
   * One page of waivers, newest first (`created_at`, `id` DESC). In force only unless
   * `includeCleared` (active, and #2778: its end date not passed); one company's only when
   * `tenant` is given.
   */
  async list(filter: {
    tenant?: TenantKey;
    includeCleared: boolean;
    after: EntityCursor | null;
    limit: number;
  }): Promise<RvmWaiverWithUses[]> {
    const endDates = !filter.includeCleared && (await this.endDatesReadable());
    const rows = await this.db
      .select()
      .from(rvmApplicantWaivers)
      .where(
        and(
          filter.includeCleared ? undefined : eq(rvmApplicantWaivers.active, true),
          endDates ? NOT_ENDED : undefined,
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
    const ids = rows.map((r) => r.id);
    const [uses, ends] = await Promise.all([this.usesOf(ids), this.endsOf(ids)]);
    return rows.map((r) => ({ ...r, waivedOpens: uses.get(r.id) ?? 0, end: ends.get(r.id) ?? null }));
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
   * #2778: while end dates are on (and their table present), a waiver whose last day has passed
   * frees nobody — the same clause {@link isActiveForShare} re-checks inside the open.
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
      const notEnded = (await this.endDatesReadable()) ? NOT_ENDED : undefined;
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
            notEnded,
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
            notEnded,
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
   *
   * #2778: while end dates are on, also "its last day has not passed" — the clause the quote's
   * {@link waiversFor} used, on the same database clock, so a waiver that ended between the price
   * read and this re-read refuses the open exactly as a cleared one does.
   */
  async isActiveForShare(tx: Database, waiverId: string): Promise<boolean> {
    const byId = eq(rvmApplicantWaivers.id, waiverId);
    const rows = await tx
      .select({ active: rvmApplicantWaivers.active })
      .from(rvmApplicantWaivers)
      .where((await this.endDatesReadable(tx)) ? and(byId, NOT_ENDED) : byId)
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

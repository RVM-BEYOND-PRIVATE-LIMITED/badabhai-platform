import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  applications,
  auditLogs,
  jobPostings,
  managedHiringCallbackRequests,
  managedHiringInterest,
  managedHiringOrders,
  payers,
  workerInstituteLinks,
  workers,
  RVM_INSTITUTE_CODE,
  type Database,
  type ManagedHiringCallbackRequestRow,
  type ManagedHiringInterestRow,
  type ManagedHiringOrderRow,
} from "@badabhai/db";
import type {
  JobPostingStatus,
  ManagedHiringCallbackReason,
  ManagedHiringOrderStatus,
  ManagedHiringTier,
  VacancyBand,
} from "@badabhai/types";
import type { EntityCursor } from "../admin/admin-entities.cursor";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";

/** The posting facts a quote and an order read (the tenant's own posting only). */
export interface ManagedHiringJobRow {
  readonly id: string;
  readonly status: JobPostingStatus;
  readonly hiddenAt: Date | null;
  readonly vacancyBand: VacancyBand;
  readonly minExperienceYears: number | null;
  readonly roleKind: string | null;
  readonly tradeLevel: string | null;
}

/** The statuses that hold the job's one open order (the partial unique index). */
export const OPEN_ORDER_STATUSES = [
  "created",
  "active",
  "extended",
] as const satisfies readonly ManagedHiringOrderStatus[];

export interface NewManagedHiringOrder {
  readonly payerId: TenantKey;
  readonly createdBy: string;
  readonly jobPostingId: string;
  readonly tier: ManagedHiringTier;
  readonly paymentOrderId: string;
  readonly priceInr: number;
  readonly targetCount: number;
  readonly workingDays: number;
  readonly extensionDays: number;
  readonly isTest: boolean;
}

export interface OrderWithCount extends ManagedHiringOrderRow {
  readonly confirmedCount: number;
}

export type AdminOrderFilter = "open" | "ended" | "all";

/**
 * Every read and write of the three `managed_hiring_*` tables (#2751 items 4 to 13). The service
 * calls it only while the `managed_hiring` switch is on (for the company, or anywhere for the
 * sweep and the admin routes), so nothing names the tables before their migration.
 *
 * Ids, closed codes, integers and times — except the tracker's staff note, which only the admin
 * reads ({@link listInterest} with `withNote`).
 */
@Injectable()
export class ManagedHiringRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx as unknown as Database));
  }

  // ── The job and the company ─────────────────────────────────────────────────────────────

  /** The tenant's own posting, or undefined (unknown and another company's read the same). */
  async findOwnJob(
    tenant: TenantKey,
    jobPostingId: string,
  ): Promise<ManagedHiringJobRow | undefined> {
    const rows = await this.db
      .select({
        id: jobPostings.id,
        status: jobPostings.status,
        hiddenAt: jobPostings.hiddenAt,
        vacancyBand: jobPostings.vacancyBand,
        minExperienceYears: jobPostings.minExperienceYears,
        roleKind: jobPostings.roleKind,
        tradeLevel: jobPostings.tradeLevel,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobPostingId), eq(jobPostings.payerId, tenant)))
      .limit(1);
    return rows[0];
  }

  /**
   * The company's account kind and test mark, read on the TENANT row (the org's anchor): an agency
   * (`agent`) — placement agency or contractor alike — may not buy Managed Hiring (brief section 2
   * and 4C.8), and a staff test company's orders are marked `is_test` (#2746).
   */
  async companyFacts(
    tenant: TenantKey,
  ): Promise<{ role: "employer" | "agent" | null; isTest: boolean } | undefined> {
    const rows = await this.db
      .select({ role: payers.role, isTest: payers.isTestAccount })
      .from(payers)
      .where(eq(payers.id, tenant))
      .limit(1);
    const row = rows[0];
    return row ? { role: row.role ?? null, isTest: row.isTest } : undefined;
  }

  // ── Orders ──────────────────────────────────────────────────────────────────────────────

  /** The job's one open order (`created`, `active` or `extended`), or undefined. */
  async findOpenOrderForJob(
    jobPostingId: string,
    tx?: Database,
  ): Promise<ManagedHiringOrderRow | undefined> {
    const rows = await (tx ?? this.db)
      .select()
      .from(managedHiringOrders)
      .where(
        and(
          eq(managedHiringOrders.jobPostingId, jobPostingId),
          inArray(managedHiringOrders.status, [...OPEN_ORDER_STATUSES]),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Write a `created` order on the checkout's transaction. Undefined when the job already holds an
   * open order (the partial unique index: a racing checkout lost), so the caller can answer 409.
   */
  async insertOrderWithinTx(
    tx: Database,
    order: NewManagedHiringOrder,
  ): Promise<ManagedHiringOrderRow | undefined> {
    const rows = await tx
      .insert(managedHiringOrders)
      .values({ ...order, status: "created" })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  async findOrderByPaymentOrder(
    paymentOrderId: string,
    tx?: Database,
  ): Promise<ManagedHiringOrderRow | undefined> {
    const rows = await (tx ?? this.db)
      .select()
      .from(managedHiringOrders)
      .where(eq(managedHiringOrders.paymentOrderId, paymentOrderId))
      .limit(1);
    return rows[0];
  }

  /** One of the tenant's orders, with its tracker count, or undefined. */
  async findOrderForTenant(
    tenant: TenantKey,
    orderId: string,
  ): Promise<OrderWithCount | undefined> {
    const rows = await this.db
      .select()
      .from(managedHiringOrders)
      .where(and(eq(managedHiringOrders.id, orderId), eq(managedHiringOrders.payerId, tenant)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { ...row, confirmedCount: await this.countInterest(row.id) };
  }

  /** The tenant's orders, newest first (optionally one job's), each with its tracker count. */
  async listOrdersForTenant(
    tenant: TenantKey,
    jobPostingId: string | undefined,
    limit: number,
  ): Promise<OrderWithCount[]> {
    const rows = await this.db
      .select()
      .from(managedHiringOrders)
      .where(
        and(
          eq(managedHiringOrders.payerId, tenant),
          jobPostingId ? eq(managedHiringOrders.jobPostingId, jobPostingId) : undefined,
        ),
      )
      .orderBy(desc(managedHiringOrders.createdAt), desc(managedHiringOrders.id))
      .limit(limit);
    return this.withCounts(rows);
  }

  async getOrder(orderId: string): Promise<OrderWithCount | undefined> {
    const rows = await this.db
      .select()
      .from(managedHiringOrders)
      .where(eq(managedHiringOrders.id, orderId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { ...row, confirmedCount: await this.countInterest(row.id) };
  }

  /** Every company's orders for the desk, keyset by (created_at desc, id desc). */
  async listOrdersForAdmin(filter: {
    status: AdminOrderFilter;
    after: EntityCursor | null;
    limit: number;
  }): Promise<OrderWithCount[]> {
    const statusClause =
      filter.status === "open"
        ? inArray(managedHiringOrders.status, ["active", "extended"])
        : filter.status === "ended"
          ? inArray(managedHiringOrders.status, ["met", "closed_unmet", "cancelled"])
          : ne(managedHiringOrders.status, "created");
    const after = filter.after;
    const rows = await this.db
      .select()
      .from(managedHiringOrders)
      .where(
        and(
          statusClause,
          after
            ? or(
                lt(managedHiringOrders.createdAt, new Date(after.createdAt)),
                and(
                  eq(managedHiringOrders.createdAt, new Date(after.createdAt)),
                  lt(managedHiringOrders.id, after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(managedHiringOrders.createdAt), desc(managedHiringOrders.id))
      .limit(filter.limit);
    return this.withCounts(rows);
  }

  /** Lock one order for a state change (FOR UPDATE), inside the caller's transaction. */
  async lockOrder(tx: Database, orderId: string): Promise<ManagedHiringOrderRow | undefined> {
    const rows = await tx
      .select()
      .from(managedHiringOrders)
      .where(eq(managedHiringOrders.id, orderId))
      .for("update")
      .limit(1);
    return rows[0];
  }

  /**
   * Payment captured: `created` → `active`, the clock stamped. A compare-and-set on the status, so
   * only the ONE settle that claimed the payment order moves it (the claim already ran once).
   */
  async activateWithinTx(
    tx: Database,
    orderId: string,
    clock: { startedAt: Date; dueAt: Date; extendedUntil: Date },
  ): Promise<ManagedHiringOrderRow | undefined> {
    const rows = await tx
      .update(managedHiringOrders)
      .set({
        status: "active",
        startedAt: clock.startedAt,
        dueAt: clock.dueAt,
        extendedUntil: clock.extendedUntil,
        updatedAt: sql`now()`,
      })
      .where(and(eq(managedHiringOrders.id, orderId), eq(managedHiringOrders.status, "created")))
      .returning();
    return rows[0];
  }

  /** A locked open order moves on: `extended`, `met` or `closed_unmet`. Compare-and-set. */
  async moveWithinTx(
    tx: Database,
    orderId: string,
    from: ManagedHiringOrderStatus,
    to: "extended" | "met" | "closed_unmet",
    at: Date,
  ): Promise<ManagedHiringOrderRow | undefined> {
    const rows = await tx
      .update(managedHiringOrders)
      .set({
        status: to,
        ...(to === "extended" ? { extendedAt: at } : { endedAt: at }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(managedHiringOrders.id, orderId), eq(managedHiringOrders.status, from)))
      .returning();
    return rows[0];
  }

  /**
   * The open orders the sweep must look at now: `active` past its deadline, or `extended` past its
   * extension's end. Oldest first, at most `limit`.
   */
  async dueOrderIds(limit: number, now: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: managedHiringOrders.id })
      .from(managedHiringOrders)
      .where(
        or(
          and(eq(managedHiringOrders.status, "active"), lte(managedHiringOrders.dueAt, now)),
          and(
            eq(managedHiringOrders.status, "extended"),
            lte(managedHiringOrders.extendedUntil, now),
          ),
        ),
      )
      .orderBy(managedHiringOrders.dueAt)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  // ── The tracker ─────────────────────────────────────────────────────────────────────────

  async countInterest(orderId: string, tx?: Database): Promise<number> {
    const rows = await (tx ?? this.db)
      .select({ n: count() })
      .from(managedHiringInterest)
      .where(eq(managedHiringInterest.orderId, orderId));
    return Number(rows[0]?.n ?? 0);
  }

  /** The tracker, oldest confirmation first. */
  async listInterest(orderId: string): Promise<ManagedHiringInterestRow[]> {
    return this.db
      .select()
      .from(managedHiringInterest)
      .where(eq(managedHiringInterest.orderId, orderId))
      .orderBy(managedHiringInterest.confirmedAt, managedHiringInterest.id);
  }

  /** Add one worker. Undefined when he is already on this order's tracker (unique per order). */
  async insertInterestWithinTx(
    tx: Database,
    row: { orderId: string; payerId: string; workerId: string; confirmedBy: string; note: string },
  ): Promise<ManagedHiringInterestRow | undefined> {
    const rows = await tx
      .insert(managedHiringInterest)
      .values(row)
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  /** Remove one worker. Undefined when he was not on this order's tracker. */
  async deleteInterestWithinTx(
    tx: Database,
    orderId: string,
    workerId: string,
  ): Promise<ManagedHiringInterestRow | undefined> {
    const rows = await tx
      .delete(managedHiringInterest)
      .where(
        and(
          eq(managedHiringInterest.orderId, orderId),
          eq(managedHiringInterest.workerId, workerId),
        ),
      )
      .returning();
    return rows[0];
  }

  // ── Who may go on a tracker ─────────────────────────────────────────────────────────────

  /** He exists, is not scheduled for deletion and is not suspended (payer surfaces freeze him). */
  async isWorkerReachable(workerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: workers.id })
      .from(workers)
      .where(
        and(
          eq(workers.id, workerId),
          isNull(workers.deletionScheduledAt),
          ne(workers.status, "suspended"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** An ACTIVE RVM institute link (#2752): an RVM student may be reached only by applying. */
  async isRvmStudent(workerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ workerId: workerInstituteLinks.workerId })
      .from(workerInstituteLinks)
      .where(
        and(
          eq(workerInstituteLinks.workerId, workerId),
          eq(workerInstituteLinks.status, "active"),
          eq(workerInstituteLinks.instituteCode, RVM_INSTITUTE_CODE),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** He applied to this posting (an `applied` decision he has not taken back). */
  async hasAppliedTo(workerId: string, jobPostingId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.workerId, workerId),
          eq(applications.jobPostingId, jobPostingId),
          eq(applications.action, "applied"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  // ── Callback requests ───────────────────────────────────────────────────────────────────

  /** One per job: undefined when the job already asked (the caller reads the first back). */
  async insertCallbackWithinTx(
    tx: Database,
    row: {
      payerId: string;
      requestedBy: string;
      jobPostingId: string;
      vacancyBand: VacancyBand;
      reason: ManagedHiringCallbackReason;
      isTest: boolean;
    },
  ): Promise<ManagedHiringCallbackRequestRow | undefined> {
    const rows = await tx
      .insert(managedHiringCallbackRequests)
      .values(row)
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  async findCallbackForJob(
    jobPostingId: string,
  ): Promise<ManagedHiringCallbackRequestRow | undefined> {
    const rows = await this.db
      .select()
      .from(managedHiringCallbackRequests)
      .where(eq(managedHiringCallbackRequests.jobPostingId, jobPostingId))
      .limit(1);
    return rows[0];
  }

  async listCallbacks(
    after: EntityCursor | null,
    limit: number,
  ): Promise<ManagedHiringCallbackRequestRow[]> {
    return this.db
      .select()
      .from(managedHiringCallbackRequests)
      .where(
        after
          ? or(
              lt(managedHiringCallbackRequests.createdAt, new Date(after.createdAt)),
              and(
                eq(managedHiringCallbackRequests.createdAt, new Date(after.createdAt)),
                lt(managedHiringCallbackRequests.id, after.id),
              ),
            )
          : undefined,
      )
      .orderBy(
        desc(managedHiringCallbackRequests.createdAt),
        desc(managedHiringCallbackRequests.id),
      )
      .limit(limit);
  }

  // ── Audit ───────────────────────────────────────────────────────────────────────────────

  /** The desk's audit row, in the change's own transaction. */
  async audit(
    tx: Database,
    entry: { adminId: string; action: string; orderId: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: entry.adminId,
      action: entry.action,
      entityType: "managed_hiring_order",
      entityId: entry.orderId,
      metadata: entry.metadata,
    });
  }

  private async withCounts(rows: ManagedHiringOrderRow[]): Promise<OrderWithCount[]> {
    if (rows.length === 0) return [];
    const counts = await this.db
      .select({ orderId: managedHiringInterest.orderId, n: count() })
      .from(managedHiringInterest)
      .where(
        inArray(
          managedHiringInterest.orderId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(managedHiringInterest.orderId);
    const byOrder = new Map(counts.map((c) => [c.orderId, Number(c.n)]));
    return rows.map((r) => ({ ...r, confirmedCount: byOrder.get(r.id) ?? 0 }));
  }
}

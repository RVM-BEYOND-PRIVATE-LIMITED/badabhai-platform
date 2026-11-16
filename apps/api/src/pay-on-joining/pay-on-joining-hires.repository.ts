import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  auditLogs,
  payOnJoiningHires,
  type Database,
  type NewPayOnJoiningHire,
  type PayOnJoiningHire,
} from "@badabhai/db";
import type { PojPaymentState } from "@badabhai/event-schema";
import type { EntityCursor } from "../admin/admin-entities.cursor";
import { DATABASE } from "../database/database.module";

/** A list row, plus the full-precision `created_at` the next page's cursor is built from. */
export type PojHireRow = PayOnJoiningHire & { sortKey: string };

/** The list filter, every field optional. */
export interface PojHireFilter {
  factoryPayerId?: string;
  partnerPayerId?: string;
  paid?: PojPaymentState;
}

/** The columns a create sets: everything but the id and the timestamps' defaults. */
export type PojHireWrite = Omit<NewPayOnJoiningHire, "id" | "createdAt" | "updatedAt">;

/** The columns an edit may set: never the creator, and never the percent copied at create. */
export type PojHireUpdate = Partial<Omit<PojHireWrite, "createdByAdminId" | "partnerSharePercent">>;

const t = payOnJoiningHires;

/**
 * #2753 item 11 — the ONE reader and writer of `pay_on_joining_hires`. Called only through
 * `PayOnJoiningHiresService`, behind `PayOnJoiningFlagGuard`: with the switch off nothing here runs.
 *
 * Every write takes the caller's transaction, so the row, its `audit_logs` row and its events
 * commit together or not at all.
 */
@Injectable()
export class PayOnJoiningHiresRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * `created_at` at full (microsecond) precision as ISO-8601, made by POSTGRES: a JS `Date` keeps
   * milliseconds only, and a cursor built from one would skip a row written in the same
   * millisecond (the `AdminAiTracesRepository.SORT_KEY` fix).
   */
  private static readonly SORT_KEY = sql<string>`to_char(${t.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

  /**
   * The SQL twin of `paymentStateOf` (pay-on-joining.state.ts). The DB gate holds the two to the
   * same answer over seeded rows of every state.
   */
  static paymentStateIs(state: PojPaymentState): SQL {
    const partnerOwed = and(
      isNotNull(t.partnerPayerId),
      gt(t.partnerSharePaise, 0),
      isNull(t.partnerPaidOn),
    )!;
    switch (state) {
      case "awaiting_factory":
        return isNull(t.factoryPaidOn);
      case "partner_due":
        return and(isNotNull(t.factoryPaidOn), partnerOwed)!;
      case "settled":
        return and(isNotNull(t.factoryPaidOn), sql`NOT (${partnerOwed})`)!;
    }
  }

  /** One keyset page (fetch `limit + 1` to know whether another follows), newest first. */
  async list(
    filter: PojHireFilter,
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<PojHireRow[]> {
    const clauses: SQL[] = [];
    if (filter.factoryPayerId !== undefined) {
      clauses.push(eq(t.factoryPayerId, filter.factoryPayerId));
    }
    if (filter.partnerPayerId !== undefined) {
      clauses.push(eq(t.partnerPayerId, filter.partnerPayerId));
    }
    if (filter.paid !== undefined)
      clauses.push(PayOnJoiningHiresRepository.paymentStateIs(filter.paid));
    if (cursor !== null) {
      // "Strictly older than the cursor" under DESC (created_at, id), at full precision.
      const at = sql`${cursor.createdAt}::text::timestamptz`;
      clauses.push(or(lt(t.createdAt, at), and(eq(t.createdAt, at), lt(t.id, cursor.id)))!);
    }
    return this.db
      .select({ ...this.columns(), sortKey: PayOnJoiningHiresRepository.SORT_KEY })
      .from(t)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
  }

  /** The row under a write lock, for an edit's read-merge-write. */
  async lockById(tx: Database, id: string): Promise<PayOnJoiningHire | undefined> {
    const rows = await tx.select().from(t).where(eq(t.id, id)).for("update").limit(1);
    return rows[0];
  }

  async insert(tx: Database, values: PojHireWrite): Promise<PayOnJoiningHire> {
    const [row] = await tx.insert(t).values(values).returning();
    if (!row) throw new Error("pay_on_joining_hires insert returned no row");
    return row;
  }

  /** Set the given columns and stamp the editor; `partner_share_percent` is never among them. */
  async update(tx: Database, id: string, set: PojHireUpdate): Promise<PayOnJoiningHire> {
    const [row] = await tx
      .update(t)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(t.id, id))
      .returning();
    if (!row) throw new Error("pay_on_joining_hires update returned no row");
    return row;
  }

  /**
   * The `audit_logs` row for a write: the acting admin, the action code and the changed field
   * KEYS. Never a value, and never the note — `audit_logs` outlives every erasure.
   */
  async writeAudit(
    tx: Database,
    input: { adminId: string; hireId: string; action: string; changedFields: readonly string[] },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: input.adminId,
      action: input.action,
      entityType: "pay_on_joining_hire",
      entityId: input.hireId,
      metadata: { changed_fields: [...input.changedFields] },
    });
  }

  /** Every column by name, so the list's select also carries the sort key. */
  private columns() {
    return {
      id: t.id,
      factoryPayerId: t.factoryPayerId,
      jobPostingId: t.jobPostingId,
      workerId: t.workerId,
      partnerPayerId: t.partnerPayerId,
      joinedOn: t.joinedOn,
      stayCheckedOn: t.stayCheckedOn,
      stayed30Days: t.stayed30Days,
      feePaise: t.feePaise,
      partnerSharePercent: t.partnerSharePercent,
      partnerSharePaise: t.partnerSharePaise,
      invoicedOn: t.invoicedOn,
      factoryPaidOn: t.factoryPaidOn,
      partnerPaidOn: t.partnerPaidOn,
      note: t.note,
      createdByAdminId: t.createdByAdminId,
      updatedByAdminId: t.updatedByAdminId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    } satisfies Record<keyof PayOnJoiningHire, unknown>;
  }
}

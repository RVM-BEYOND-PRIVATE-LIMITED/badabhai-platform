import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lt, or, sql, sum, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  creditLedger,
  payerCredits,
  paymentOrders,
  type CreditReason,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { EntityCursor } from "./admin-entities.cursor";
import { ADMIN_TOP_BALANCES } from "./admin-finance.dto";
import type {
  AdminBalanceRow,
  AdminLedgerRow,
  AdminOrderRow,
  AdminReasonBucket,
} from "./admin-finance.dto";

/**
 * SELECT-ONLY data access for the admin FINANCE reads (BP-2).
 *
 * Same discipline as the entity repository: explicit column projections, keyset pagination,
 * hard caps, and no insert/update/delete anywhere. Money is written by the unlock/credit
 * services, which emit their own events; nothing here may write, or a balance could change
 * with no audit trail.
 *
 * NOT PROJECTED, deliberately: `payment_ref`, `provider_payment_ref`, `provider_order_id`,
 * `idempotency_key`. All four are documented as opaque, but they are produced by an external
 * system or a caller, so they are the fields whose contents this codebase cannot vouch for.
 * The screens do not need them.
 *
 * KEYSET INDEXES: migration 0065 adds the platform-wide `(created_at DESC, id DESC)` indexes
 * on `credit_ledger` and `payment_orders`. The pre-existing payer-leading indexes cannot
 * serve an unscoped scan.
 */
@Injectable()
export class AdminFinanceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * "Strictly older than the cursor" under DESC `(created_at, id)`.
   *
   * `lt`/`eq` on the COLUMN, never an interpolated `sql` template — the template hands the
   * value to the driver unmapped, which is what made every cursor-bearing admin request 500
   * before BP-1 (see `admin-keyset-params.test.ts`).
   */
  private static before(createdAtCol: PgColumn, idCol: PgColumn, cursor: EntityCursor): SQL {
    const at = new Date(cursor.createdAt);
    return or(lt(createdAtCol, at), and(eq(createdAtCol, at), lt(idCol, cursor.id)))!;
  }

  // ---- credit balances ----------------------------------------------------

  /** Total credits held across every payer — the platform's outstanding liability. */
  async outstandingCredits(): Promise<{ credits: number; payers: number }> {
    const rows = await this.db
      .select({ total: sum(payerCredits.balance), payers: count() })
      .from(payerCredits);
    return {
      // `sum` returns a numeric STRING (or null on an empty table) — coerce explicitly
      // rather than letting `"0"` reach the UI as a string that renders but never adds up.
      credits: Number(rows[0]?.total ?? 0),
      payers: rows[0]?.payers ?? 0,
    };
  }

  /** The largest balances. Bounded — a summary, never an export. */
  async topBalances(limit = ADMIN_TOP_BALANCES): Promise<AdminBalanceRow[]> {
    const rows = await this.db
      .select({ payerId: payerCredits.payerId, balance: payerCredits.balance })
      .from(payerCredits)
      .orderBy(desc(payerCredits.balance), desc(payerCredits.payerId))
      .limit(limit);
    return rows.map((r) => ({ payer_id: r.payerId, balance: r.balance }));
  }

  // ---- ledger -------------------------------------------------------------

  /** Credit movement grouped by reason over a window. */
  async ledgerByReason(since: Date): Promise<AdminReasonBucket[]> {
    const rows = await this.db
      .select({
        reason: creditLedger.reason,
        movements: count(),
        creditsDelta: sum(creditLedger.delta),
        // A null `price_inr` (a debit, a grant, or any pre-0043 row) contributes NOTHING —
        // it is never guessed from the current catalog, which would retroactively rewrite
        // what a past purchase appears to have cost.
        //
        // `SUM` already skips nulls, so no inner COALESCE is needed (measured, not assumed:
        // `sum(coalesce(p,0))` and `sum(p)` both return 100 over `[null, 100, null]`). The
        // OUTER coalesce is the one doing work — it turns the all-null bucket's `NULL` into
        // a 0 the caller can add up. An earlier version wrapped both and carried a comment
        // claiming the inner one was load-bearing; it was not.
        amountInr: sql<string>`coalesce(sum(${creditLedger.priceInr}), 0)`,
      })
      .from(creditLedger)
      .where(gte(creditLedger.createdAt, since))
      .groupBy(creditLedger.reason);

    return rows.map((r) => ({
      reason: r.reason as CreditReason,
      movements: r.movements,
      credits_delta: Number(r.creditsDelta ?? 0),
      amount_inr: Number(r.amountInr ?? 0),
    }));
  }

  async listLedger(
    filter: { payerId?: string; reason?: string },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminLedgerRow[]> {
    const clauses: SQL[] = [];
    if (filter.payerId) clauses.push(eq(creditLedger.payerId, filter.payerId));
    if (filter.reason) clauses.push(eq(creditLedger.reason, filter.reason as never));
    if (cursor) {
      clauses.push(AdminFinanceRepository.before(creditLedger.createdAt, creditLedger.id, cursor));
    }

    const rows = await this.db
      .select({
        id: creditLedger.id,
        payerId: creditLedger.payerId,
        delta: creditLedger.delta,
        reason: creditLedger.reason,
        unlockId: creditLedger.unlockId,
        packCode: creditLedger.packCode,
        priceInr: creditLedger.priceInr,
        createdAt: creditLedger.createdAt,
      })
      .from(creditLedger)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      payer_id: r.payerId,
      delta: r.delta,
      reason: r.reason,
      unlock_id: r.unlockId,
      pack_code: r.packCode,
      price_inr: r.priceInr,
      created_at: r.createdAt,
    }));
  }

  // ---- payment orders -----------------------------------------------------

  /** Order counts + amounts by status over a window. */
  async ordersByStatus(
    since: Date,
  ): Promise<Array<{ status: string; count: number; amountInr: number; credits: number }>> {
    const rows = await this.db
      .select({
        status: paymentOrders.status,
        n: count(),
        amountInr: sql<string>`coalesce(sum(${paymentOrders.amountInr}), 0)`,
        credits: sql<string>`coalesce(sum(${paymentOrders.creditsGranted}), 0)`,
      })
      .from(paymentOrders)
      .where(gte(paymentOrders.createdAt, since))
      .groupBy(paymentOrders.status);

    return rows.map((r) => ({
      status: r.status,
      count: r.n,
      amountInr: Number(r.amountInr ?? 0),
      credits: Number(r.credits ?? 0),
    }));
  }

  async listOrders(
    filter: { payerId?: string; status?: string },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminOrderRow[]> {
    const clauses: SQL[] = [];
    if (filter.payerId) clauses.push(eq(paymentOrders.payerId, filter.payerId));
    if (filter.status) clauses.push(eq(paymentOrders.status, filter.status as never));
    if (cursor) {
      clauses.push(
        AdminFinanceRepository.before(paymentOrders.createdAt, paymentOrders.id, cursor),
      );
    }

    const rows = await this.db
      .select({
        id: paymentOrders.id,
        payerId: paymentOrders.payerId,
        packCode: paymentOrders.packCode,
        amountInr: paymentOrders.amountInr,
        creditsGranted: paymentOrders.creditsGranted,
        provider: paymentOrders.provider,
        status: paymentOrders.status,
        createdAt: paymentOrders.createdAt,
        updatedAt: paymentOrders.updatedAt,
      })
      .from(paymentOrders)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(paymentOrders.createdAt), desc(paymentOrders.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      payer_id: r.payerId,
      pack_code: r.packCode,
      amount_inr: r.amountInr,
      credits_granted: r.creditsGranted,
      provider: r.provider,
      status: r.status,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }
}

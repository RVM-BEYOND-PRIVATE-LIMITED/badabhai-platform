import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  applications,
  auditLogs,
  creditLedger,
  creditLots,
  jobPostings,
  paymentOrders,
  paymentRefunds,
  reverseLotWithinTx,
  type Database,
  type PaymentOrder,
  type PaymentRefundFailure,
  type PaymentRefundRow,
  type PaymentRefundRule,
  type PaymentRefundStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The pack lot a paid order created (#2749: one lot per order). */
export interface OrderPackLot {
  readonly id: string;
  readonly creditsGranted: number;
  readonly creditsRemaining: number;
  /** Stamped when the lot was expired or reversed: it holds nothing any more. */
  readonly expiredAt: Date | null;
  /** When the credits arrived: the settle. Refund windows count from here. */
  readonly createdAt: Date;
}

/** The ledger key of the ONE `pack_refund` line a lot can ever get. */
export function packRefundIdempotencyKey(lotId: string): string {
  return `pack_refund:${lotId}`;
}

/**
 * Data access for `payment_refunds` (#2750 item 10) and the reads a refund decision needs: the
 * order, its pack lot, the credits that came back with it (#2750 item 9) and rule 2's applicant
 * count. The only reader and writer of the table. Every write takes the caller's transaction, so
 * the refund row, the credits it removes, its audit row and its event commit together.
 */
@Injectable()
export class PaymentRefundsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The pool, for the reads that take a handle (a transaction's, or this one outside one). */
  get reader(): Database {
    return this.db;
  }

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx as unknown as Database));
  }

  /** The order, unlocked (the eligibility read). */
  async getOrder(orderId: string): Promise<PaymentOrder | undefined> {
    const [row] = await this.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, orderId))
      .limit(1);
    return row;
  }

  /** The order, locked for the refund decision: two refunds of one order serialise here. */
  async lockOrder(tx: Database, orderId: string): Promise<PaymentOrder | undefined> {
    const [row] = await tx
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, orderId))
      .for("update");
    return row;
  }

  /** The pack lot the order's settle created, or undefined (an order with no lot is not a pack). */
  async findPackLot(db: Database, orderId: string): Promise<OrderPackLot | undefined> {
    const [row] = await db
      .select({
        id: creditLots.id,
        creditsGranted: creditLots.creditsGranted,
        creditsRemaining: creditLots.creditsRemaining,
        expiredAt: creditLots.expiredAt,
        createdAt: creditLots.createdAt,
      })
      .from(creditLots)
      .where(and(eq(creditLots.paymentOrderId, orderId), eq(creditLots.source, "pack")))
      .limit(1);
    return row;
  }

  /**
   * The `returned` lots that came back WITH this order's pack (#2750 item 9: their `pack_return`
   * lines carry the order's provider payment id). A refund takes back what they still hold.
   */
  async returnedLotIds(db: Database, walletKey: string, paymentRef: string): Promise<string[]> {
    const rows = await db
      .select({ lotId: creditLedger.lotId })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.payerId, walletKey),
          eq(creditLedger.reason, "pack_return"),
          eq(creditLedger.paymentRef, paymentRef),
        ),
      );
    return rows.map((r) => r.lotId).filter((id): id is string => id !== null);
  }

  /** True when the posting belongs to this wallet (the order's own tenant key). */
  async postingOwnedBy(db: Database, postingId: string, walletKey: string): Promise<boolean> {
    const [row] = await db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, postingId), eq(jobPostings.payerId, walletKey)))
      .limit(1);
    return row !== undefined;
  }

  /** Rule 2's count: the people who applied to the posting (owner ruling 2026-11-18). */
  async countApplicants(db: Database, postingId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(applications)
      .where(and(eq(applications.jobPostingId, postingId), eq(applications.action, "applied")));
    return Number(row?.n ?? 0);
  }

  /**
   * Take back what one lot still holds: one `pack_refund` line (key `pack_refund:<lot id>`), the
   * lot closed, the balance lowered (the wallet helper). Returns the credits taken back.
   */
  async removeLot(tx: Database, walletKey: string, lotId: string): Promise<number> {
    const done = await reverseLotWithinTx(tx, {
      payerId: walletKey,
      lotId,
      reason: "pack_refund",
      idempotencyKey: packRefundIdempotencyKey(lotId),
    });
    return done.applied ? done.credits : 0;
  }

  async insertRefund(
    tx: Database,
    values: {
      paymentOrderId: string;
      payerId: string;
      rule: PaymentRefundRule;
      jobPostingId: string | null;
      applicantsCounted: number | null;
      requestedBy: string;
      amountPaise: number;
      creditsRemoved: number;
    },
  ): Promise<PaymentRefundRow> {
    const [row] = await tx.insert(paymentRefunds).values(values).returning();
    if (!row) throw new Error("payment-refunds: the refund row was not written");
    return row;
  }

  async findByOrder(db: Database, orderId: string): Promise<PaymentRefundRow | undefined> {
    const [row] = await db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.paymentOrderId, orderId))
      .limit(1);
    return row;
  }

  async getRefund(refundId: string): Promise<PaymentRefundRow | undefined> {
    const [row] = await this.db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.id, refundId))
      .limit(1);
    return row;
  }

  async findByProviderRefundId(providerRefundId: string): Promise<PaymentRefundRow | undefined> {
    const [row] = await this.db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.providerRefundId, providerRefundId))
      .limit(1);
    return row;
  }

  /**
   * Move a refund from one of `from` to `to` in one compare-and-set, stamping the provider id, the
   * failure code and the processed time as the status requires. Undefined when the row was not in
   * `from` (a concurrent webhook or retry moved it first): the caller then writes no event.
   */
  async transition(
    tx: Database,
    refundId: string,
    from: readonly PaymentRefundStatus[],
    to: PaymentRefundStatus,
    patch: { providerRefundId?: string; failureCode?: PaymentRefundFailure | null },
  ): Promise<PaymentRefundRow | undefined> {
    const [row] = await tx
      .update(paymentRefunds)
      .set({
        status: to,
        ...(patch.providerRefundId !== undefined
          ? { providerRefundId: patch.providerRefundId }
          : {}),
        failureCode: to === "failed" ? (patch.failureCode ?? "provider_error") : null,
        processedAt: to === "processed" ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(paymentRefunds.id, refundId), inArray(paymentRefunds.status, [...from])))
      .returning();
    return row;
  }

  /** The refund's audit row (the admin, the action, the reason), in the change's transaction. */
  async audit(
    tx: Database,
    entry: { adminId: string; action: string; refundId: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: entry.adminId,
      action: entry.action,
      entityType: "payment_refund",
      entityId: entry.refundId,
      metadata: entry.metadata,
    });
  }
}

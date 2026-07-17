import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  type Database,
  type Unlock,
  type UnlockRouting,
  type PayerCredit,
  type CreditReason,
  type UnlockStatus,
  type UnlockDenyReason,
  type RoutingChannel,
  unlocks,
  unlockRouting,
  payerCredits,
  creditLedger,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { OPS_LIST_CAP } from "../common/pagination";

/**
 * A Drizzle transaction handle. The chokepoint ({@link UnlockService}) opens ONE
 * transaction per grant/reveal and threads `tx` through these methods, so the
 * cap-check + credit-debit + grant/reveal-write are ONE atomic operation
 * (Phase-0 F-2 / F-6). `Tx` is the first argument of a `db.transaction` callback.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** PII-free projection of a credit_ledger movement (amounts + opaque ids only). */
export interface CreditLedgerItem {
  id: string;
  delta: number;
  reason: CreditReason;
  unlock_id: string | null;
  pack_code: string | null;
  payment_ref: string | null;
  /**
   * The ₹ amount STAMPED at purchase (D-6). Null for movements with no amount (debits /
   * ops grants) and for rows written before the column existed — the UI renders an honest
   * placeholder for null and NEVER back-fills from the current catalog (that is exactly
   * the retroactive re-pricing this column removes).
   */
  price_inr: number | null;
  created_at: Date;
}

/** PII-free ops/list projection of an unlock row (NO routing token resolved). */
export interface UnlockProjection {
  unlock_id: string;
  payer_id: string;
  // NULLABLE post-ADR-0026 Phase 5: a worker hard-delete (DSAR) SET-NULLs the identity join
  // while preserving this PII-free paid-grant row (migration 0030). The reveal path guards on
  // a null worker_id BEFORE relaying (a gone worker cannot be revealed).
  worker_id: string | null;
  job_id: string | null;
  status: UnlockStatus;
  reveal_count: number;
  granted_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

/**
 * Drizzle data access for Contact Unlock + Reveal (ADR-0010, Stream A). PURE data
 * access — no business logic, no event emission (those live in {@link UnlockService}).
 *
 * STRUCTURAL chokepoint (Phase-0 F-2/F-5/T5-b): the WRITE methods for `unlocks` and
 * `unlock_routing`, and the routing-token resolver, are tx-scoped and are only ever
 * called from {@link UnlockService}. No other module imports this repository. The
 * raw phone is NEVER read or written here — it is touched only transiently in the
 * service's reveal handler.
 */
@Injectable()
export class UnlocksRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` inside a single DB transaction (the chokepoint's atomic boundary). */
  async withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * Take a transaction-scoped advisory lock keyed on `worker_id` (Phase-0 F-2). All
   * grants + reveals for one worker serialize on this lock, so N concurrent requests
   * can NEVER each read "under cap" and all write — the cap check + write that follow
   * inside the same `tx` are effectively atomic per worker. The lock is released when
   * the transaction commits/rolls back. We hash the UUID to a bigint key space.
   */
  async lockWorker(tx: Tx, workerId: string): Promise<void> {
    // hashtextextended is stable; cast to bigint for pg_advisory_xact_lock(bigint).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workerId}, 0))`);
  }

  /** The existing unlock for (payer, worker), or undefined. Tx-scoped read. */
  async findByPayerWorker(tx: Tx, payerId: string, workerId: string): Promise<Unlock | undefined> {
    const rows = await tx
      .select()
      .from(unlocks)
      .where(and(eq(unlocks.payerId, payerId), eq(unlocks.workerId, workerId)))
      .limit(1);
    return rows[0];
  }

  /** A single unlock by id (tx-scoped, locked for the reveal flow). */
  async findByIdForUpdate(tx: Tx, unlockId: string): Promise<Unlock | undefined> {
    const rows = await tx
      .select()
      .from(unlocks)
      .where(eq(unlocks.id, unlockId))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /**
   * Count distinct GRANTED/REVEALED reveals for a worker since `since` (cap window).
   * "Reveals" = unlocks for this worker whose reveal_count > 0 since `since`, summed.
   * Used for the daily-reveals cap. Tx-scoped so it sees this txn's writes.
   */
  async countRevealsSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ total: sql<number>`coalesce(sum(${unlocks.revealCount}), 0)::int` })
      .from(unlocks)
      .where(and(eq(unlocks.workerId, workerId), gte(unlocks.grantedAt, since)));
    return rows[0]?.total ?? 0;
  }

  /** Count DISTINCT payers who hold a grant for a worker since `since` (weekly cap). */
  async countDistinctPayersSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(distinct ${unlocks.payerId})::int` })
      .from(unlocks)
      .where(
        and(
          eq(unlocks.workerId, workerId),
          gte(unlocks.grantedAt, since),
          // Only count actually-granted/revealed unlocks (a denied row is not a contact).
          sql`${unlocks.status} in ('granted','revealed')`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * Upsert the GRANTED unlock for (payer, worker) — idempotent on the unique
   * (payer_id, worker_id). Tx-scoped. Sets status=granted, the routing token ref,
   * granted_at, expires_at, clears any prior deny_reason.
   */
  async upsertGrant(
    tx: Tx,
    input: {
      payerId: string;
      workerId: string;
      jobId: string | null;
      routingTokenRef: string;
      grantedAt: Date;
      expiresAt: Date;
    },
  ): Promise<Unlock> {
    const rows = await tx
      .insert(unlocks)
      .values({
        payerId: input.payerId,
        workerId: input.workerId,
        jobId: input.jobId,
        status: "granted" satisfies UnlockStatus,
        denyReason: null,
        routingTokenRef: input.routingTokenRef,
        grantedAt: input.grantedAt,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [unlocks.payerId, unlocks.workerId],
        set: {
          jobId: input.jobId,
          status: "granted" satisfies UnlockStatus,
          denyReason: null,
          routingTokenRef: input.routingTokenRef,
          grantedAt: input.grantedAt,
          expiresAt: input.expiresAt,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert unlock grant");
    return row;
  }

  /**
   * Record a DENIED unlock for the audit spine — idempotent on (payer, worker). The
   * deny_reason is INTERNAL only (CHECK enforces it is set only on status=denied). It
   * never reaches the payer. Tx-scoped. Returns the row so the caller can event its id.
   */
  async recordDeny(
    tx: Tx,
    input: {
      payerId: string;
      workerId: string;
      jobId: string | null;
      denyReason: UnlockDenyReason;
    },
  ): Promise<Unlock> {
    const rows = await tx
      .insert(unlocks)
      .values({
        payerId: input.payerId,
        workerId: input.workerId,
        jobId: input.jobId,
        status: "denied" satisfies UnlockStatus,
        denyReason: input.denyReason,
      })
      .onConflictDoUpdate({
        target: [unlocks.payerId, unlocks.workerId],
        set: {
          // Preserve an existing GRANT — a deny must never downgrade a live grant.
          // We only stamp the deny when there is no granted/revealed row already.
          status: sql`case when ${unlocks.status} in ('granted','revealed') then ${unlocks.status} else 'denied' end`,
          denyReason: sql`case when ${unlocks.status} in ('granted','revealed') then ${unlocks.denyReason} else ${input.denyReason} end`,
          jobId: input.jobId,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to record unlock deny");
    return row;
  }

  /** Set an unlock to status=revealed and bump reveal_count by 1 (tx-scoped). */
  async incrementReveal(tx: Tx, unlockId: string): Promise<number> {
    const rows = await tx
      .update(unlocks)
      .set({
        status: "revealed" satisfies UnlockStatus,
        revealCount: sql`${unlocks.revealCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(unlocks.id, unlockId))
      .returning({ revealCount: unlocks.revealCount });
    const count = rows[0]?.revealCount;
    if (count === undefined) throw new Error("Failed to increment reveal_count");
    return count;
  }

  /**
   * Write the SERVER-SIDE routing mapping (tx-scoped). PII-FREE: routing token,
   * channel kind, the non-reversible expiring relay handle, expiry — NEVER a phone.
   */
  async createRouting(
    tx: Tx,
    input: {
      unlockId: string;
      routingToken: string;
      channel: RoutingChannel;
      relayHandle: string;
      expiresAt: Date;
    },
  ): Promise<UnlockRouting> {
    const rows = await tx
      .insert(unlockRouting)
      .values({
        unlockId: input.unlockId,
        routingToken: input.routingToken,
        channel: input.channel,
        relayHandle: input.relayHandle,
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create unlock routing");
    return row;
  }

  // -------------------------------------------------------------------------
  // Credit ledger / balance (mock; F-6). The DB CHECK (balance >= 0) plus the
  // atomic conditional decrement below guarantee balance never goes negative.
  // -------------------------------------------------------------------------

  /** The payer's credit balance row, or undefined (tx-scoped, locked). */
  async findCreditsForUpdate(tx: Tx, payerId: string): Promise<PayerCredit | undefined> {
    const rows = await tx
      .select()
      .from(payerCredits)
      .where(eq(payerCredits.payerId, payerId))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /** The payer's current balance (non-tx read), or 0 if no row. Ops read. */
  async getBalance(payerId: string): Promise<number> {
    const rows = await this.db
      .select({ balance: payerCredits.balance })
      .from(payerCredits)
      .where(eq(payerCredits.payerId, payerId))
      .limit(1);
    return rows[0]?.balance ?? 0;
  }

  /**
   * The payer's OWN credit-ledger movements, newest first, bounded by `limit`. The append-only
   * source of truth behind the balance — amounts + opaque ids only (PII-free by table design;
   * no currency/PAN/UPI). Scoped by `payer_id` (the caller's SESSION id) so a payer only ever
   * sees their OWN rows. Read-only.
   *
   * ⚠️ Selects `price_inr` EXPLICITLY (D-6) ⇒ requires migration 0043. APPLY BEFORE DEPLOY:
   * against an unmigrated DB this read fails outright (not a silently-null column).
   */
  async listCreditLedgerByPayer(payerId: string, limit: number): Promise<CreditLedgerItem[]> {
    return this.db
      .select({
        id: creditLedger.id,
        delta: creditLedger.delta,
        reason: creditLedger.reason,
        unlock_id: creditLedger.unlockId,
        pack_code: creditLedger.packCode,
        payment_ref: creditLedger.paymentRef,
        price_inr: creditLedger.priceInr, // D-6: the STAMPED charge, never re-priced.
        created_at: creditLedger.createdAt,
      })
      .from(creditLedger)
      .where(eq(creditLedger.payerId, payerId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(limit);
  }

  /**
   * ATOMIC conditional debit of one credit (F-6): decrements balance only WHERE
   * balance >= amount, returning the new balance — or undefined if there were
   * insufficient credits (no row updated). Combined with the DB CHECK this makes a
   * negative balance impossible even under concurrency. Tx-scoped.
   */
  async tryDebit(tx: Tx, payerId: string, amount: number): Promise<number | undefined> {
    const rows = await tx
      .update(payerCredits)
      .set({ balance: sql`${payerCredits.balance} - ${amount}`, updatedAt: sql`now()` })
      .where(and(eq(payerCredits.payerId, payerId), gte(payerCredits.balance, amount)))
      .returning({ balance: payerCredits.balance });
    return rows[0]?.balance;
  }

  /** Append a credit-ledger movement (tx-scoped — the source of truth). */
  async appendLedger(
    tx: Tx,
    input: {
      payerId: string;
      delta: number;
      reason: CreditReason;
      unlockId?: string | null;
      packCode?: string | null;
      paymentRef?: string | null;
    },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      payerId: input.payerId,
      delta: input.delta,
      reason: input.reason,
      unlockId: input.unlockId ?? null,
      packCode: input.packCode ?? null,
      paymentRef: input.paymentRef ?? null,
    });
  }

  /**
   * Credit a pack purchase / ops grant (NON-tx convenience for the mock top-up
   * endpoint): upsert the balance row (+credits) and append the ledger in ONE
   * transaction. Returns the new balance.
   *
   * ⚠️ Inserts `price_inr` EXPLICITLY (D-6) ⇒ requires migration 0043. APPLY BEFORE DEPLOY:
   * against an unmigrated DB EVERY pack purchase fails on this insert.
   */
  async creditPack(input: {
    payerId: string;
    credits: number;
    reason: CreditReason;
    packCode: string | null;
    paymentRef: string | null;
    /**
     * The amount CHARGED, whole ₹ (D-6). Stamped onto the row so History renders what this
     * purchase ACTUALLY cost, immune to any later ops price edit. Null for ops grants /
     * movements with no amount.
     */
    priceInr?: number | null;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .insert(payerCredits)
        .values({ payerId: input.payerId, balance: input.credits })
        .onConflictDoUpdate({
          target: payerCredits.payerId,
          set: { balance: sql`${payerCredits.balance} + ${input.credits}`, updatedAt: sql`now()` },
        })
        .returning({ balance: payerCredits.balance });
      await tx.insert(creditLedger).values({
        payerId: input.payerId,
        delta: input.credits,
        reason: input.reason,
        packCode: input.packCode,
        paymentRef: input.paymentRef,
        priceInr: input.priceInr ?? null,
      });
      const balance = updated[0]?.balance;
      if (balance === undefined) throw new Error("Failed to credit pack");
      return balance;
    });
  }

  /** PII-free list of a payer's unlocks (ops read). NO routing token resolved. */
  async listByPayer(payerId: string): Promise<UnlockProjection[]> {
    const rows = await this.db
      .select()
      .from(unlocks)
      .where(eq(unlocks.payerId, payerId))
      .orderBy(desc(unlocks.createdAt)) // deterministic newest-first under the cap
      .limit(OPS_LIST_CAP); // bound an otherwise-unbounded ops read
    return rows.map((u) => this.project(u));
  }

  /** A single unlock projection by id (ops read), or undefined. PII-free. */
  async getProjection(unlockId: string): Promise<UnlockProjection | undefined> {
    const rows = await this.db.select().from(unlocks).where(eq(unlocks.id, unlockId)).limit(1);
    const row = rows[0];
    return row ? this.project(row) : undefined;
  }

  private project(u: Unlock): UnlockProjection {
    return {
      unlock_id: u.id,
      payer_id: u.payerId,
      worker_id: u.workerId,
      job_id: u.jobId,
      status: u.status,
      reveal_count: u.revealCount,
      granted_at: u.grantedAt,
      expires_at: u.expiresAt,
      created_at: u.createdAt,
    };
  }
}

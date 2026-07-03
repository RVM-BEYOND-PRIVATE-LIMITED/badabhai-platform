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
  created_at: Date;
}

/** PII-free ops/list projection of an unlock row (NO routing token resolved). */
export interface UnlockProjection {
  unlock_id: string;
  payer_id: string;
  // ADR-0027 B5.x Inc 2: the tenant-ownership key. `payer_id` STAYS in the projection
  // (ops/audit still read the acting payer), but ownership/IDOR now key on `org_id`.
  // NULLABLE only defensively (Inc 0 backfilled it NOT NULL for every payer-owned row).
  org_id: string | null;
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

  /**
   * The existing unlock for (org, worker), or undefined. Tx-scoped read.
   * ADR-0027 B5.x Inc 2: ownership/idempotency keys on `org_id` (replaces the
   * payer-keyed lookup) — any member of the org converges on the same grant row.
   */
  async findByOrgWorker(tx: Tx, orgId: string, workerId: string): Promise<Unlock | undefined> {
    const rows = await tx
      .select()
      .from(unlocks)
      .where(and(eq(unlocks.orgId, orgId), eq(unlocks.workerId, workerId)))
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

  /**
   * Count DISTINCT ORGS that hold a grant for a worker since `since` (weekly cap).
   * ADR-0027 B5.x Inc 2: worker-protection counts distinct EMPLOYERS (orgs), not distinct
   * acting payers — so a whole recruiting team (many payers, one org) counts as ONE
   * toward the weekly cap, while two DISTINCT orgs count as two. BEHAVIOR-PRESERVING under
   * today's solo orgs (org == the one payer), where distinct orgs == distinct payers. The
   * `"weekly_payers"` cap KIND string + the `unlock.cap_exceeded` payload are UNCHANGED
   * (no schema change) — only the counted unit flips from payer to org.
   */
  async countDistinctOrgsSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(distinct ${unlocks.orgId})::int` })
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
   * Upsert the GRANTED unlock for (org, worker) — idempotent on the unique
   * (org_id, worker_id) (ADR-0027 B5.x Inc 2). Tx-scoped. INSERT stamps BOTH `org_id`
   * (the new ownership key) AND `payer_id` (still NOT NULL — the acting payer, kept for
   * ops/audit + rollback). Sets status=granted, the routing token ref, granted_at,
   * expires_at, clears any prior deny_reason.
   */
  async upsertGrant(
    tx: Tx,
    input: {
      orgId: string;
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
        orgId: input.orgId,
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
        target: [unlocks.orgId, unlocks.workerId],
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
   * Record a DENIED unlock for the audit spine — idempotent on (org, worker) (ADR-0027
   * B5.x Inc 2). INSERT stamps BOTH `org_id` (ownership key) AND `payer_id` (still NOT
   * NULL — the acting payer). The deny_reason is INTERNAL only (CHECK enforces it is set
   * only on status=denied). It never reaches the payer. Tx-scoped. Returns the row so the
   * caller can event its id.
   */
  async recordDeny(
    tx: Tx,
    input: {
      orgId: string;
      payerId: string;
      workerId: string;
      jobId: string | null;
      denyReason: UnlockDenyReason;
    },
  ): Promise<Unlock> {
    const rows = await tx
      .insert(unlocks)
      .values({
        orgId: input.orgId,
        payerId: input.payerId,
        workerId: input.workerId,
        jobId: input.jobId,
        status: "denied" satisfies UnlockStatus,
        denyReason: input.denyReason,
      })
      .onConflictDoUpdate({
        target: [unlocks.orgId, unlocks.workerId],
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

  /**
   * The ORG's credit balance row, or undefined (tx-scoped, locked). ADR-0027 B5.x Inc 2:
   * the wallet is keyed on `org_id` (one wallet per org — a whole team shares it).
   */
  async findCreditsForUpdate(tx: Tx, orgId: string): Promise<PayerCredit | undefined> {
    const rows = await tx
      .select()
      .from(payerCredits)
      .where(eq(payerCredits.orgId, orgId))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /** The ORG's current balance (non-tx read), or 0 if no row. Ops read. */
  async getBalance(orgId: string): Promise<number> {
    const rows = await this.db
      .select({ balance: payerCredits.balance })
      .from(payerCredits)
      .where(eq(payerCredits.orgId, orgId))
      .limit(1);
    return rows[0]?.balance ?? 0;
  }

  /**
   * The ORG's credit-ledger movements, newest first, bounded by `limit`. The append-only
   * source of truth behind the balance — amounts + opaque ids only (PII-free by table design;
   * no currency/PAN/UPI). ADR-0027 B5.x Inc 2: scoped by `org_id` (the shared org wallet's
   * ledger) so any org member sees the ORG's movements — resolved from the caller's session
   * payer upstream, never a body value. Read-only.
   */
  async listCreditLedgerByOrg(orgId: string, limit: number): Promise<CreditLedgerItem[]> {
    return this.db
      .select({
        id: creditLedger.id,
        delta: creditLedger.delta,
        reason: creditLedger.reason,
        unlock_id: creditLedger.unlockId,
        pack_code: creditLedger.packCode,
        payment_ref: creditLedger.paymentRef,
        created_at: creditLedger.createdAt,
      })
      .from(creditLedger)
      .where(eq(creditLedger.orgId, orgId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(limit);
  }

  /**
   * ATOMIC conditional debit of one credit from the ORG wallet (F-6): decrements balance
   * only WHERE org_id = orgId AND balance >= amount, returning the new balance — or
   * undefined if there were insufficient credits (no row updated). Combined with the DB
   * CHECK (balance >= 0) this makes a negative balance impossible even under concurrency.
   * Tx-scoped. ADR-0027 B5.x Inc 2: keys on `org_id` (the shared org wallet).
   */
  async tryDebit(tx: Tx, orgId: string, amount: number): Promise<number | undefined> {
    const rows = await tx
      .update(payerCredits)
      .set({ balance: sql`${payerCredits.balance} - ${amount}`, updatedAt: sql`now()` })
      .where(and(eq(payerCredits.orgId, orgId), gte(payerCredits.balance, amount)))
      .returning({ balance: payerCredits.balance });
    return rows[0]?.balance;
  }

  /**
   * Append a credit-ledger movement (tx-scoped — the source of truth). ADR-0027 B5.x
   * Inc 2: stamps BOTH `org_id` (the wallet key) AND `payer_id` (still NOT NULL — the
   * acting payer, kept for ops/audit).
   */
  async appendLedger(
    tx: Tx,
    input: {
      orgId: string;
      payerId: string;
      delta: number;
      reason: CreditReason;
      unlockId?: string | null;
      packCode?: string | null;
      paymentRef?: string | null;
    },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      orgId: input.orgId,
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
   * endpoint): upsert the ORG's balance row (+credits) and append the ledger in ONE
   * transaction. Returns the new balance. ADR-0027 B5.x Inc 2: the wallet upserts on
   * (org_id) and both the wallet row + ledger row stamp `org_id` AND `payer_id`.
   */
  async creditPack(input: {
    orgId: string;
    payerId: string;
    credits: number;
    reason: CreditReason;
    packCode: string | null;
    paymentRef: string | null;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .insert(payerCredits)
        .values({ orgId: input.orgId, payerId: input.payerId, balance: input.credits })
        .onConflictDoUpdate({
          target: payerCredits.orgId,
          set: { balance: sql`${payerCredits.balance} + ${input.credits}`, updatedAt: sql`now()` },
        })
        .returning({ balance: payerCredits.balance });
      await tx.insert(creditLedger).values({
        orgId: input.orgId,
        payerId: input.payerId,
        delta: input.credits,
        reason: input.reason,
        packCode: input.packCode,
        paymentRef: input.paymentRef,
      });
      const balance = updated[0]?.balance;
      if (balance === undefined) throw new Error("Failed to credit pack");
      return balance;
    });
  }

  /**
   * PII-free list of an ORG's unlocks (ops read). NO routing token resolved. ADR-0027
   * B5.x Inc 2: scoped on `org_id`, so any member sees the whole org's unlocks.
   */
  async listByOrg(orgId: string): Promise<UnlockProjection[]> {
    const rows = await this.db
      .select()
      .from(unlocks)
      .where(eq(unlocks.orgId, orgId))
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
      org_id: u.orgId,
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

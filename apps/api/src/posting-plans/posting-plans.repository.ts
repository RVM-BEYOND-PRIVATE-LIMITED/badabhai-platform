import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  type Database,
  jobPostings,
  postingPlans,
  postingBoosts,
  payerCapacity,
  events,
  type PostingPlan,
  type NewPostingPlan,
  type PostingBoost,
  type NewPostingBoost,
  type PayerCapacity,
  type PostingPlanStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** Coupon redemption counts (for fail-closed cap enforcement at purchase). */
export interface CouponUsageCounts {
  readonly total: number;
  readonly perPayer: number;
}

/**
 * A Drizzle transaction handle. The capacity chokepoint ({@link PostingPlansService})
 * opens ONE transaction per buy/upgrade and threads `tx` through these methods, so the
 * count-active-vacancies → decide-status → write is ONE atomic operation under a
 * per-payer advisory lock (ADR-0016 / ADR-0010 F-2 discipline). `Tx` is the first
 * argument of a `db.transaction` callback.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

@Injectable()
export class PostingPlansRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` inside a single DB transaction (the chokepoint's atomic boundary). */
  async withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * Take a transaction-scoped advisory lock keyed on `payer_id` (ADR-0016 / F-2). All
   * capacity-affecting writes for one payer serialize on this lock, so N concurrent
   * buys can NEVER each read "under cap" and all write 'active' — the count-and-write
   * that follows inside the same `tx` is effectively atomic per payer. Released on
   * commit/rollback. We hash the UUID into the bigint key space (mirrors unlocks).
   */
  async lockPayer(tx: Tx, payerId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${payerId}, 0))`);
  }

  /**
   * Count this payer's CURRENTLY-ACTIVE vacancies = posting_plans in status='active'
   * that are not expired (expires_at null or in the future). DERIVED (no side counter,
   * no drift; ADR-0016). Tx-scoped so it sees this txn's writes under the advisory lock.
   */
  async countActivePlansForPayer(tx: Tx, payerId: string, now: Date): Promise<number> {
    const rows = await tx
      .select({ c: count() })
      .from(postingPlans)
      .where(
        and(
          eq(postingPlans.payerId, payerId),
          eq(postingPlans.status, "active"),
          or(isNull(postingPlans.expiresAt), gt(postingPlans.expiresAt, now)),
        ),
      );
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * The payer's capacity row, or undefined. Pass `tx` to read the allowance UNDER the
   * per-payer advisory lock during a buy (ADR-0016 / F-2): reading on the locked tx's own
   * connection (not a second pool connection) is what keeps the chokepoint deadlock-free
   * at concurrency ≥ pool size — same discipline as every other in-lock read. `this.db`
   * is the standalone (ops/no-lock) path.
   */
  async getCapacity(payerId: string, tx?: Tx): Promise<PayerCapacity | undefined> {
    const exec = tx ?? this.db;
    const rows = await exec
      .select()
      .from(payerCapacity)
      .where(eq(payerCapacity.payerId, payerId))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the payer's capacity allowance — idempotent on the unique payer_id (ADR-0016).
   * RAISES max_active_vacancies to the tier grant; stamps source_tier + expires_at. The
   * GREATEST guard means a re-applied (or older/smaller) grant can never LOWER a live
   * allowance — an upgrade only ever grows it (so a replayed purchase is naturally safe).
   * Tx-scoped (called under the advisory lock during auto-resume) or standalone.
   */
  async upsertCapacity(
    input: { payerId: string; maxActiveVacancies: number; sourceTier: string | null; expiresAt: Date | null },
    tx?: Tx,
  ): Promise<PayerCapacity> {
    const exec = tx ?? this.db;
    const rows = await exec
      .insert(payerCapacity)
      .values({
        payerId: input.payerId,
        maxActiveVacancies: input.maxActiveVacancies,
        sourceTier: input.sourceTier,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: payerCapacity.payerId,
        set: {
          maxActiveVacancies: sql`greatest(${payerCapacity.maxActiveVacancies}, ${input.maxActiveVacancies})`,
          sourceTier: input.sourceTier,
          expiresAt: input.expiresAt,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert payer capacity");
    return row;
  }

  /**
   * A payer's PAUSED plans, oldest-paid first (deterministic auto-resume order;
   * ADR-0016). Tx-scoped (read under the advisory lock so it sees a consistent set).
   */
  async listPausedPlansForPayer(tx: Tx, payerId: string): Promise<PostingPlan[]> {
    return tx
      .select()
      .from(postingPlans)
      .where(and(eq(postingPlans.payerId, payerId), eq(postingPlans.status, "paused")))
      .orderBy(asc(postingPlans.paidAt));
  }

  /** Set a plan's status (tx-scoped; used to flip paused→active on resume). */
  async setPlanStatus(tx: Tx, planId: string, status: PostingPlanStatus): Promise<void> {
    await tx
      .update(postingPlans)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(postingPlans.id, planId));
  }

  /** Whether a job posting exists (existence-only; no PII read). */
  async postingExists(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Insert a posting plan. `input.status` is explicit ('active' | 'paused' per the
   * capacity decision; ADR-0016). Tx-scoped when `tx` is supplied so the insert is
   * part of the count-and-write atomic step under the per-payer advisory lock.
   */
  async insertPlan(input: NewPostingPlan, tx?: Tx): Promise<PostingPlan> {
    const exec = tx ?? this.db;
    const rows = await exec.insert(postingPlans).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create posting plan");
    return row;
  }

  async insertBoost(input: NewPostingBoost): Promise<PostingBoost> {
    const rows = await this.db.insert(postingBoosts).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create posting boost");
    return row;
  }

  /** An active, unexpired boost on a posting (B-R3: reject overlapping boosts). */
  async findActiveBoost(jobPostingId: string, now: Date): Promise<PostingBoost | undefined> {
    const rows = await this.db
      .select()
      .from(postingBoosts)
      .where(
        and(
          eq(postingBoosts.jobPostingId, jobPostingId),
          eq(postingBoosts.status, "active"),
          gt(postingBoosts.boostEndsAt, now),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Count coupon redemptions from the `coupon.redeemed` event spine (the source of
   * truth) — total across all payers + this payer's count — so the engine enforces
   * totalUsageCap / perPayerLimit fail-closed at purchase. PII-free (codes + ids).
   */
  async couponUsage(couponCode: string, payerId: string): Promise<CouponUsageCounts> {
    const base = and(
      eq(events.eventName, "coupon.redeemed"),
      sql`${events.payload} ->> 'coupon_code' = ${couponCode}`,
    );
    const totalRows = await this.db.select({ c: count() }).from(events).where(base);
    const payerRows = await this.db
      .select({ c: count() })
      .from(events)
      .where(and(base, sql`${events.payload} ->> 'payer_id' = ${payerId}`));
    return { total: Number(totalRows[0]?.c ?? 0), perPayer: Number(payerRows[0]?.c ?? 0) };
  }
}

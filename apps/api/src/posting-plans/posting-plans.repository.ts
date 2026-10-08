import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
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
import type { TenantKey } from "../payers/payer-tenant-scope";

/** Coupon redemption counts (for fail-closed cap enforcement at purchase). */
export interface CouponUsageCounts {
  readonly total: number;
  /** Redemptions by the TENANT (ADR-0053 O-4: `perPayerLimit` is per org once the flag is on). */
  readonly perPayer: number;
}

/**
 * A plan / boost insert (ADR-0053 §5.2 rule 3, hand-converted: the Drizzle `New…` types carry
 * `payer_id` as a plain string, which the T5 scan cannot see). The row's owner is the resolved
 * TENANT key, never a raw id; who bought it is the event envelope's actor (§7).
 */
export type NewTenantPostingPlan = Omit<NewPostingPlan, "payerId"> & { payerId: TenantKey };
export type NewTenantPostingBoost = Omit<NewPostingBoost, "payerId"> & { payerId: TenantKey };

/**
 * A Drizzle transaction handle. The capacity chokepoint ({@link PostingPlansService})
 * opens ONE transaction per buy/upgrade and threads `tx` through these methods, so the
 * count-active-vacancies → decide-status → write is ONE atomic operation under a
 * per-tenant advisory lock (ADR-0016 / ADR-0010 F-2 discipline; ADR-0053). `Tx` is the first
 * argument of a `db.transaction` callback.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * ADR-0053 (PAY-DB-01) P2c: every predicate and stamp on `posting_plans`, `posting_boosts` and
 * `payer_capacity` takes the branded {@link TenantKey} the resolver mints — never a raw id — and
 * so does the capacity lock and the coupon count. In mode `off` the key is the caller itself.
 */
@Injectable()
export class PostingPlansRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` inside a single DB transaction (the chokepoint's atomic boundary). */
  async withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * Take a transaction-scoped advisory lock keyed on the TENANT (ADR-0016 / F-2; ADR-0053 §6:
   * the capacity lock is per org). All capacity-affecting writes for one tenant serialize on
   * this lock, so N concurrent buys — by one login or by several members of one org — can
   * NEVER each read "under cap" and all write 'active': the count-and-write that follows
   * inside the same `tx` is effectively atomic per tenant. Released on commit/rollback. We
   * hash the UUID into the bigint key space (mirrors unlocks). Hand-converted (T5 blind spot
   * 1: the lock touches no table).
   */
  async lockPayer(tx: Tx, tenant: TenantKey): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenant}, 0))`);
  }

  /**
   * Count the tenant's CURRENTLY-ACTIVE vacancies = posting_plans in status='active'
   * that are not expired (expires_at null or in the future). DERIVED (no side counter,
   * no drift; ADR-0016). Tx-scoped so it sees this txn's writes under the advisory lock.
   */
  async countActivePlansForPayer(tx: Tx, tenant: TenantKey, now: Date): Promise<number> {
    const rows = await tx
      .select({ c: count() })
      .from(postingPlans)
      .where(
        and(
          eq(postingPlans.payerId, tenant),
          eq(postingPlans.status, "active"),
          or(isNull(postingPlans.expiresAt), gt(postingPlans.expiresAt, now)),
        ),
      );
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * The tenant's capacity row (one allowance per org, ADR-0053 §4), or undefined. Pass `tx`
   * to read the allowance UNDER the per-tenant advisory lock during a buy (ADR-0016 / F-2):
   * reading on the locked tx's own connection (not a second pool connection) is what keeps
   * the chokepoint deadlock-free at concurrency ≥ pool size — same discipline as every other
   * in-lock read. `this.db` is the standalone (no-lock) path.
   */
  async getCapacity(tenant: TenantKey, tx?: Tx): Promise<PayerCapacity | undefined> {
    const exec = tx ?? this.db;
    const rows = await exec
      .select()
      .from(payerCapacity)
      .where(eq(payerCapacity.payerId, tenant))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the tenant's capacity allowance — idempotent on the unique payer_id (ADR-0016).
   * RAISES max_active_vacancies to the tier grant; stamps source_tier + expires_at. The
   * GREATEST guard means a re-applied (or older/smaller) grant can never LOWER a live
   * allowance — an upgrade only ever grows it (so a replayed purchase is naturally safe).
   * Tx-scoped (called under the advisory lock during auto-resume) or standalone.
   */
  async upsertCapacity(
    input: {
      payerId: TenantKey;
      maxActiveVacancies: number;
      sourceTier: string | null;
      expiresAt: Date | null;
    },
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
   * A tenant's PAUSED plans, oldest-paid first (deterministic auto-resume order;
   * ADR-0016). Tx-scoped (read under the advisory lock so it sees a consistent set).
   */
  async listPausedPlansForPayer(tx: Tx, tenant: TenantKey): Promise<PostingPlan[]> {
    return tx
      .select()
      .from(postingPlans)
      .where(and(eq(postingPlans.payerId, tenant), eq(postingPlans.status, "paused")))
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
  /**
   * ADR-0050 §4.3 — the posting's `sync_source` (null for a native posting), or `undefined` when
   * there is no such posting. The plan/boost purchases refuse a twin with the fence's 409.
   */
  async findPostingSyncSource(id: string): Promise<string | null | undefined> {
    const rows = await this.db
      .select({ syncSource: jobPostings.syncSource })
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1);
    return rows[0] === undefined ? undefined : rows[0].syncSource;
  }

  /**
   * Insert a posting plan, owned by the TENANT ({@link NewTenantPostingPlan}). `input.status`
   * is explicit ('active' | 'paused' per the capacity decision; ADR-0016). Tx-scoped when
   * `tx` is supplied so the insert is part of the count-and-write atomic step under the
   * per-tenant advisory lock.
   */
  async insertPlan(input: NewTenantPostingPlan, tx?: Tx): Promise<PostingPlan> {
    const exec = tx ?? this.db;
    const rows = await exec.insert(postingPlans).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create posting plan");
    return row;
  }

  /** Insert a booster receipt, owned by the TENANT ({@link NewTenantPostingBoost}). */
  async insertBoost(input: NewTenantPostingBoost): Promise<PostingBoost> {
    const rows = await this.db.insert(postingBoosts).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create posting boost");
    return row;
  }

  /**
   * ADR-0036 §7 — push out the SERVED entity's boost window by `boostDays`.
   *
   * `job_postings.boosted_until` is the DERIVED serving state the feed's ORDER BY reads
   * (`(boosted_until > now()) DESC`), so the hottest read in the system needs no join to
   * `posting_boosts`. `posting_boosts` remains the immutable RECEIPT — one row per
   * purchase, never updated by this.
   *
   * `GREATEST(now(), boosted_until) + N days` — EXTEND, never overwrite. Buying a second
   * boost while one is running must ADD to the window; setting it to N days from today
   * would sell a payer time they already own and take some away. `GREATEST` also handles
   * an EXPIRED previous window correctly (it falls through to `now()`), and `COALESCE`
   * handles a posting that has never been boosted.
   *
   * ONE STATEMENT, computed in SQL against the database's own clock: a read-modify-write
   * in application code would race two concurrent purchases and lose one of the windows.
   */
  async extendPostingBoostWindow(jobPostingId: string, boostDays: number): Promise<Date | null> {
    const rows = await this.db
      .update(jobPostings)
      .set({
        boostedUntil: sql`GREATEST(now(), COALESCE(${jobPostings.boostedUntil}, now()))
                          + make_interval(days => ${boostDays})`,
        updatedAt: sql`now()`,
      })
      .where(eq(jobPostings.id, jobPostingId))
      .returning({ boostedUntil: jobPostings.boostedUntil });
    return rows[0]?.boostedUntil ?? null;
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
   * The tenant's single ACTIVE, unexpired plan for a posting — the target of a quota top-up
   * (B2). Latest-paid first (if a posting somehow carries more than one active plan, the
   * most recent receipt is the one topped up). TENANT-SCOPED (`payer_id` in the WHERE) so a
   * foreign plan is invisible; a plain read (no lock — {@link addQuotaTopup} is the atomic
   * guard). PII-free (ids/counts only).
   */
  async findActivePlanForPostingAndPayer(
    jobPostingId: string,
    tenant: TenantKey,
    now: Date,
  ): Promise<PostingPlan | undefined> {
    const rows = await this.db
      .select()
      .from(postingPlans)
      .where(
        and(
          eq(postingPlans.jobPostingId, jobPostingId),
          eq(postingPlans.payerId, tenant),
          eq(postingPlans.status, "active"),
          or(isNull(postingPlans.expiresAt), gt(postingPlans.expiresAt, now)),
        ),
      )
      .orderBy(desc(postingPlans.paidAt))
      .limit(1);
    return rows[0];
  }

  /**
   * Atomically add `delta` applicant-visibility views to a plan's quota_topup_count (B2).
   * ONE UPDATE (`SET col = col + delta`) so concurrent top-ups COMPOSE without a lock. The
   * WHERE re-asserts the plan is still the tenant's + active + unexpired (no TOCTOU vs the
   * read in {@link findActivePlanForPostingAndPayer}): returns undefined if the plan changed
   * or expired in between → the caller 409s. The immutable `applicant_visibility_quota`
   * receipt is NEVER touched. PII-free.
   */
  async addQuotaTopup(
    planId: string,
    tenant: TenantKey,
    delta: number,
    now: Date,
  ): Promise<PostingPlan | undefined> {
    const rows = await this.db
      .update(postingPlans)
      .set({
        quotaTopupCount: sql`${postingPlans.quotaTopupCount} + ${delta}`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(postingPlans.id, planId),
          eq(postingPlans.payerId, tenant),
          eq(postingPlans.status, "active"),
          or(isNull(postingPlans.expiresAt), gt(postingPlans.expiresAt, now)),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * Count coupon redemptions from the `coupon.redeemed` event spine (the source of
   * truth) — total across all payers + this TENANT's count — so the engine enforces
   * totalUsageCap / perPayerLimit fail-closed at purchase. PII-free (codes + ids).
   *
   * ADR-0053 O-4: the per-payer count keys on the tenant, so `perPayerLimit` is per ORG once
   * the flag is on — `coupon.redeemed`'s payload `payer_id` carries the tenant key (§7).
   * Hand-converted (T5 blind spot 2: it reads `events`, not a tenant table).
   */
  async couponUsage(couponCode: string, tenant: TenantKey): Promise<CouponUsageCounts> {
    const base = and(
      eq(events.eventName, "coupon.redeemed"),
      sql`${events.payload} ->> 'coupon_code' = ${couponCode}`,
    );
    const totalRows = await this.db.select({ c: count() }).from(events).where(base);
    const payerRows = await this.db
      .select({ c: count() })
      .from(events)
      .where(and(base, sql`${events.payload} ->> 'payer_id' = ${tenant}`));
    return { total: Number(totalRows[0]?.c ?? 0), perPayer: Number(payerRows[0]?.c ?? 0) };
  }
}

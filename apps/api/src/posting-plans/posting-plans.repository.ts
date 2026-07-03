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

/** Coupon redemption counts (for fail-closed cap enforcement at purchase). */
export interface CouponUsageCounts {
  readonly total: number;
  readonly perPayer: number;
}

/**
 * A Drizzle transaction handle. The capacity chokepoint ({@link PostingPlansService})
 * opens ONE transaction per buy/upgrade and threads `tx` through these methods, so the
 * count-active-vacancies → decide-status → write is ONE atomic operation under a
 * per-ORG advisory lock (ADR-0016 / ADR-0010 F-2 discipline; ADR-0027 B5.x Inc 3 flips the
 * key from payer to org). `Tx` is the first argument of a `db.transaction` callback.
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
   * Take a transaction-scoped advisory lock keyed on `org_id` (ADR-0016 / F-2; ADR-0027
   * B5.x Inc 3 flips the key from payer to ORG). All capacity-affecting writes for one ORG
   * serialize on this lock, so N concurrent buys by ANY of an org's members can NEVER each
   * read "under cap" and all write 'active' — the count-and-write that follows inside the
   * same `tx` is effectively atomic per org. CRITICAL: capacity is now an ORG-shared
   * allowance, so this lock key MUST be the SAME org key the active-plan count uses
   * ({@link countActivePlansForOrg}), or the chokepoint stops being atomic. Released on
   * commit/rollback. We hash the UUID into the bigint key space (mirrors unlocks).
   */
  async lockOrg(tx: Tx, orgId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgId}, 0))`);
  }

  /**
   * Count this ORG's CURRENTLY-ACTIVE vacancies = posting_plans in status='active'
   * that are not expired (expires_at null or in the future). DERIVED (no side counter,
   * no drift; ADR-0016). Tx-scoped so it sees this txn's writes under the advisory lock.
   * ADR-0027 B5.x Inc 3: keyed on `org_id` (the shared allowance), the SAME key
   * {@link lockOrg} takes — lock key == count key == org (chokepoint atomicity).
   */
  async countActivePlansForOrg(tx: Tx, orgId: string, now: Date): Promise<number> {
    const rows = await tx
      .select({ c: count() })
      .from(postingPlans)
      .where(
        and(
          eq(postingPlans.orgId, orgId),
          eq(postingPlans.status, "active"),
          or(isNull(postingPlans.expiresAt), gt(postingPlans.expiresAt, now)),
        ),
      );
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * The ORG's capacity row, or undefined (ADR-0027 B5.x Inc 3 — the allowance is now an
   * org-shared row). Pass `tx` to read the allowance UNDER the per-org advisory lock during
   * a buy (ADR-0016 / F-2): reading on the locked tx's own connection (not a second pool
   * connection) is what keeps the chokepoint deadlock-free at concurrency ≥ pool size —
   * same discipline as every other in-lock read. `this.db` is the standalone (ops/no-lock)
   * path.
   */
  async getCapacity(orgId: string, tx?: Tx): Promise<PayerCapacity | undefined> {
    const exec = tx ?? this.db;
    const rows = await exec
      .select()
      .from(payerCapacity)
      .where(eq(payerCapacity.orgId, orgId))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the ORG's capacity allowance — idempotent on the unique org_id (ADR-0016;
   * ADR-0027 B5.x Inc 3 keys the row on org). RAISES max_active_vacancies to the tier
   * grant; stamps source_tier + expires_at. The GREATEST guard means a re-applied (or
   * older/smaller) grant can never LOWER a live allowance — an upgrade only ever grows it
   * (so a replayed purchase is naturally safe). Stamps BOTH org_id (the allowance key) +
   * payer_id (the acting buyer; both NOT-NULL from migration 0035). Tx-scoped (called under
   * the advisory lock during auto-resume) or standalone.
   */
  async upsertCapacity(
    input: {
      orgId: string;
      payerId: string;
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
        orgId: input.orgId,
        payerId: input.payerId,
        maxActiveVacancies: input.maxActiveVacancies,
        sourceTier: input.sourceTier,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: payerCapacity.orgId,
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
   * An ORG's PAUSED plans, oldest-paid first (deterministic auto-resume order; ADR-0016;
   * ADR-0027 B5.x Inc 3 keyed on org). Tx-scoped (read under the advisory lock so it sees a
   * consistent set of the org's paused plans).
   */
  async listPausedPlansForOrg(tx: Tx, orgId: string): Promise<PostingPlan[]> {
    return tx
      .select()
      .from(postingPlans)
      .where(and(eq(postingPlans.orgId, orgId), eq(postingPlans.status, "paused")))
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
   * capacity decision; ADR-0016). The caller MUST stamp BOTH `orgId` (ownership) +
   * `payerId` (the acting buyer) — both NOT-NULL from migration 0035 (ADR-0027 B5.x Inc 3).
   * Tx-scoped when `tx` is supplied so the insert is part of the count-and-write atomic step
   * under the per-org advisory lock.
   */
  async insertPlan(input: NewPostingPlan, tx?: Tx): Promise<PostingPlan> {
    const exec = tx ?? this.db;
    const rows = await exec.insert(postingPlans).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create posting plan");
    return row;
  }

  /**
   * Insert a posting boost. The caller MUST stamp BOTH `orgId` (ownership) + `payerId`
   * (the acting buyer) — both NOT-NULL from migration 0035 (ADR-0027 B5.x Inc 3).
   */
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
   * The ORG's single ACTIVE, unexpired plan for a posting — the target of a quota top-up
   * (B2). Latest-paid first (if a posting somehow carries more than one active plan, the
   * most recent receipt is the one topped up). ORG-SCOPED (`org_id` in the WHERE; ADR-0027
   * B5.x Inc 3) so a foreign-org plan is invisible but a teammate's plan on the shared org
   * is reachable; a plain read (no lock — {@link addQuotaTopup} is the atomic guard).
   * PII-free (ids/counts only).
   */
  async findActivePlanForPostingAndOrg(
    jobPostingId: string,
    orgId: string,
    now: Date,
  ): Promise<PostingPlan | undefined> {
    const rows = await this.db
      .select()
      .from(postingPlans)
      .where(
        and(
          eq(postingPlans.jobPostingId, jobPostingId),
          eq(postingPlans.orgId, orgId),
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
   * WHERE re-asserts the plan is still the org's + active + unexpired (no TOCTOU vs the
   * read in {@link findActivePlanForPostingAndOrg}): returns undefined if the plan changed
   * or expired in between → the caller 409s. ADR-0027 B5.x Inc 3: ownership re-asserted on
   * `org_id`. The immutable `applicant_visibility_quota` receipt is NEVER touched. PII-free.
   */
  async addQuotaTopup(
    planId: string,
    orgId: string,
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
          eq(postingPlans.orgId, orgId),
          eq(postingPlans.status, "active"),
          or(isNull(postingPlans.expiresAt), gt(postingPlans.expiresAt, now)),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * Count coupon redemptions from the `coupon.redeemed` event spine (the source of
   * truth) — total across all payers + this payer's count — so the engine enforces
   * totalUsageCap / perPayerLimit fail-closed at purchase. PII-free (codes + ids).
   *
   * ADR-0027 B5.x Inc 3: kept keyed on the ACTING `payer_id` (it reads the immutable
   * `coupon.redeemed` EVENT spine `payload->>'payer_id'`, which stays the acting payer — no
   * event-schema change). The per-buyer coupon cap is thus keyed on the acting payer;
   * solo-org-equivalent today. Revisit ONLY if org-shared coupon caps are ever needed.
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

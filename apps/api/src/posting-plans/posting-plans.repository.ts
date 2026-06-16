import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gt, sql } from "drizzle-orm";
import {
  type Database,
  jobPostings,
  postingPlans,
  postingBoosts,
  events,
  type PostingPlan,
  type NewPostingPlan,
  type PostingBoost,
  type NewPostingBoost,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** Coupon redemption counts (for fail-closed cap enforcement at purchase). */
export interface CouponUsageCounts {
  readonly total: number;
  readonly perPayer: number;
}

@Injectable()
export class PostingPlansRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Whether a job posting exists (existence-only; no PII read). */
  async postingExists(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1);
    return rows.length > 0;
  }

  async insertPlan(input: NewPostingPlan): Promise<PostingPlan> {
    const rows = await this.db.insert(postingPlans).values(input).returning();
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

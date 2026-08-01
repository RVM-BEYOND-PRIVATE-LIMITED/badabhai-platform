import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  type Database,
  referralClicks,
  referralLinks,
  type NewReferralClick,
  type NewReferralLink,
  type ReferralClick,
  type ReferralLink,
  type ReferralLinkMedium,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The subset of a click row a caller ever needs. The `code` never leaves this layer. */
export interface ClaimedClick {
  id: string;
  referralLinkId: string | null;
  medium: ReferralLinkMedium;
  clickedAt: Date;
}

/**
 * Data access for `referral_links` + `referral_clicks` (B4). PII-FREE: opaque ids, an
 * opaque bearer code, and a keyed HMAC click hash. The RAW ip / user-agent never reach
 * this layer — the service hashes them before calling in.
 */
@Injectable()
export class ReferralLinkRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async createLink(input: NewReferralLink): Promise<ReferralLink> {
    const [row] = await this.db.insert(referralLinks).values(input).returning();
    if (!row) throw new Error("failed to create referral link");
    return row;
  }

  async findLinkByCode(code: string): Promise<ReferralLink | undefined> {
    const [row] = await this.db
      .select()
      .from(referralLinks)
      .where(eq(referralLinks.code, code))
      .limit(1);
    return row;
  }

  async recordClick(input: NewReferralClick): Promise<ReferralClick> {
    const [row] = await this.db.insert(referralClicks).values(input).returning();
    if (!row) throw new Error("failed to record referral click");
    return row;
  }

  /**
   * FIRST-TOUCH CLAIM — the race-critical path, and the reason this method exists at all.
   *
   * Resolves at most ONE click for `workerId`, exactly once, under concurrency. Three
   * layered defenses, in the order they fire:
   *
   *  1. `pg_advisory_xact_lock(hashtextextended(worker_id))` — ALL claim attempts for one
   *     worker serialize on this lock for the life of the transaction. This is the one that
   *     handles the real-world race: two concurrent install-referrer posts carrying two
   *     DIFFERENT codes would otherwise each pick a different candidate row, and a row lock
   *     on those two different rows blocks neither. (Same idiom as
   *     `UnlocksRepository.lockWorker` — the pre-existing per-worker chokepoint.)
   *  2. `SELECT … FOR UPDATE` on the winning candidate row — holds it against any other
   *     transaction that reached it by a different path (e.g. an ops backfill).
   *  3. The partial unique index `referral_clicks_claimed_worker_uq`. The BACKSTOP: even if
   *     both locks above were somehow bypassed, the second writer's UPDATE violates it and
   *     the caller neutralises the error into "already claimed". A correctness rule that
   *     lives only in application code is the thing that races; this one has DB teeth.
   *
   * WINDOW: only clicks newer than `now - windowHours` are candidates, and the window is
   * chosen PER CLICK from that click's own snapshotted `medium` — so an organic and a paid
   * click competing for the same install are each judged under their own rule. Ordered
   * `clicked_at ASC` because the rule is FIRST touch, not last.
   *
   * Returns the claimed click, or null when there was nothing eligible (unknown code, all
   * candidates outside the window, or this worker already claimed one). Never throws for
   * any of those — they are ordinary outcomes, not errors.
   */
  async claimFirstTouch(input: {
    code: string;
    workerId: string;
    /** Window length per medium, resolved from config by the service. */
    windowHoursByMedium: Record<ReferralLinkMedium, number>;
    now: Date;
  }): Promise<ClaimedClick | null> {
    const { code, workerId, windowHoursByMedium, now } = input;

    return this.db.transaction(async (tx) => {
      // (1) Serialize every claim for this worker. Released on commit/rollback.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workerId}, 0))`);

      // Idempotency: this worker may already own a claim from an earlier (or racing,
      // now-committed) attempt. Re-claiming would violate the unique index; returning the
      // existing row keeps the caller's contract "exactly once, no error".
      const [existing] = await tx
        .select({
          id: referralClicks.id,
          referralLinkId: referralClicks.referralLinkId,
          medium: referralClicks.medium,
          clickedAt: referralClicks.clickedAt,
        })
        .from(referralClicks)
        .where(eq(referralClicks.claimedByWorkerId, workerId))
        .limit(1);
      if (existing) return null;

      // The oldest UNCLAIMED click for this code that is still inside ITS OWN medium's
      // window. Expressed as one predicate so Postgres can use
      // `referral_clicks_code_clicked_idx` rather than filtering in the app.
      const organicCutoff = new Date(
        now.getTime() - windowHoursByMedium.organic * 60 * 60 * 1000,
      );
      const paidCutoff = new Date(now.getTime() - windowHoursByMedium.paid * 60 * 60 * 1000);

      const [candidate] = await tx
        .select({
          id: referralClicks.id,
          referralLinkId: referralClicks.referralLinkId,
          medium: referralClicks.medium,
          clickedAt: referralClicks.clickedAt,
        })
        .from(referralClicks)
        .where(
          and(
            eq(referralClicks.code, code),
            isNull(referralClicks.claimedByWorkerId),
            sql`CASE ${referralClicks.medium}
                  WHEN 'paid' THEN ${referralClicks.clickedAt} >= ${paidCutoff}
                  ELSE ${referralClicks.clickedAt} >= ${organicCutoff}
                END`,
          ),
        )
        .orderBy(asc(referralClicks.clickedAt))
        .limit(1)
        // (2) Hold the winner against any other path into this row.
        .for("update");

      if (!candidate) return null;

      // (3) The write. `isNull(claimedByWorkerId)` in the predicate makes it a
      // single-winner conditional UPDATE even without the locks above; the partial unique
      // index is the final backstop if two workers somehow reach the same row.
      const updated = await tx
        .update(referralClicks)
        .set({ claimedByWorkerId: workerId, claimedAt: now })
        .where(and(eq(referralClicks.id, candidate.id), isNull(referralClicks.claimedByWorkerId)))
        .returning({ id: referralClicks.id });

      if (updated.length === 0) return null;
      return candidate;
    });
  }

  /**
   * Has this (hashed) visitor already been logged for this code inside the dedupe window?
   * Keeps a worker who refreshes the landing page from inflating the funnel. Best-effort
   * by design — a miss costs one duplicate row, never a lost attribution.
   */
  async hasRecentClick(input: {
    code: string;
    clickHash: string;
    since: Date;
  }): Promise<boolean> {
    const [row] = await this.db
      .select({ id: referralClicks.id })
      .from(referralClicks)
      .where(
        and(
          eq(referralClicks.code, input.code),
          eq(referralClicks.clickHash, input.clickHash),
          gte(referralClicks.clickedAt, input.since),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}

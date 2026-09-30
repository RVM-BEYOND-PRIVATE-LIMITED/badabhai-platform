import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import {
  type Database,
  agencyInvites,
  invites,
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
 * The PREDICATE of `referral_links_resume_qr_owner_uq` (migration 0129), spelled once. An
 * `ON CONFLICT (owner_worker_id) WHERE …` infers a PARTIAL unique index only when it repeats the
 * index's predicate, so the insert below must carry exactly this.
 */
const RESUME_QR_OWNER_INDEX_PREDICATE = sql`${referralLinks.kind} = 'resume_qr' AND ${referralLinks.ownerWorkerId} IS NOT NULL`;

/**
 * #1800 — the get-or-create INSERT of a worker's résumé-QR link, as a statement so its conflict
 * target is testable on the compiled SQL without a database (the `settleParsedStatement`
 * precedent). `DO NOTHING` on the per-owner partial unique index: a concurrent render that already
 * minted this worker's link wins, and this insert returns no row. A CODE collision is NOT this
 * conflict target and raises `23505` on `referral_links_code_uq`, which the service retries.
 */
export function insertResumeQrLinkStatement(
  db: Database,
  input: { code: string; ownerWorkerId: string },
) {
  return db
    .insert(referralLinks)
    .values({
      code: input.code,
      kind: "resume_qr",
      medium: "organic",
      agentPayerId: null,
      ownerWorkerId: input.ownerWorkerId,
      campaignId: null,
      payload: {},
      expiresAt: null,
    })
    .onConflictDoNothing({
      target: referralLinks.ownerWorkerId,
      where: RESUME_QR_OWNER_INDEX_PREDICATE,
    })
    .returning();
}

/**
 * #1800 — "is this code already live in ANY of the three code spaces?" as one statement.
 *
 * WHY ALL THREE. `GET /r/:code` resolves `referral_links` first and the attribution hook then
 * falls through to `invites` and `agency_invites`, so the three share ONE namespace in practice
 * even though each only has its own unique index. A `resume_qr` code equal to a live invite code
 * would make one scan look like both — and could put an inviter in line to be paid for a résumé
 * scan. Each lookup is a unique-index probe on `code`.
 */
export function codeTakenStatement(code: string): SQL {
  return sql`select (
    exists (select 1 from ${referralLinks} where ${referralLinks.code} = ${code})
    or exists (select 1 from ${invites} where ${invites.code} = ${code})
    or exists (select 1 from ${agencyInvites} where ${agencyInvites.code} = ${code})
  ) as "taken"`;
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

  /** #1800 — the worker's LIVE résumé-QR link, if one was ever minted. At most one exists. */
  async findResumeQrLink(ownerWorkerId: string): Promise<ReferralLink | undefined> {
    const [row] = await this.db
      .select()
      .from(referralLinks)
      .where(and(eq(referralLinks.kind, "resume_qr"), eq(referralLinks.ownerWorkerId, ownerWorkerId)))
      .limit(1);
    return row;
  }

  /**
   * Run `cb` inside one Drizzle transaction (the `ResumeSkinRepository` / must-fix H3 seam). The
   * `tx` handed to `cb` is a `Database`-shaped executor that {@link insertResumeQrLink} and
   * `EventsService.emit` both accept, so a minted link and its `referral.link_created` commit or
   * roll back together — a live bearer code is never left without its audit event.
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * #1800 — insert the worker's résumé-QR link unless they already have one. Returns the new row,
   * or `undefined` when the per-owner partial unique index said one already exists (the caller
   * re-selects). THROWS on a code collision (`23505` on `referral_links_code_uq`), and before
   * migration 0129 on the kind CHECK (`23514`) or the missing conflict index (`42P10`).
   */
  async insertResumeQrLink(
    input: { code: string; ownerWorkerId: string },
    tx: Database = this.db,
  ): Promise<ReferralLink | undefined> {
    const [row] = await insertResumeQrLinkStatement(tx, input);
    return row;
  }

  /** #1800 — whether `code` is already live in referral_links, invites or agency_invites. */
  async isCodeTaken(code: string): Promise<boolean> {
    const rows = await this.db.execute<{ taken: boolean }>(codeTakenStatement(code));
    return rows[0]?.taken === true;
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
            // PER-MEDIUM WINDOW, written with drizzle's TYPED operators rather than a raw
            // `CASE` fragment. Same rows, same index usage — but the fragment version could
            // never execute at all.
            //
            // WHY: inside `sql\`…\`` drizzle hands a JS `Date` to the driver as a bare
            // parameter with no column mapper. In a direct `clicked_at >= $2` comparison
            // Postgres infers `timestamptz` for that parameter and postgres.js serializes
            // the Date correctly; inside `CASE … WHEN … THEN clicked_at >= $2 …` it does
            // not, and postgres.js then tries to serialize a Date as TEXT and throws
            // `ERR_INVALID_ARG_TYPE` ("must be of type string or ... Received an instance
            // of Date"). `claimInstall` catches and neutralises everything, so the throw
            // was invisible: the claim silently returned "not resolved" EVERY TIME, no
            // `claimed_by_worker_id` was ever written and `referral.install_claimed` never
            // fired. Verified against a real Postgres, in isolation from the API.
            //
            // `eq`/`gte` on the column carry drizzle's timestamp mapper, so the Date is
            // encoded against the column's real type and the failure cannot recur here.
            // Prefer them over a raw fragment whenever a value is compared to a column.
            or(
              and(eq(referralClicks.medium, "paid"), gte(referralClicks.clickedAt, paidCutoff)),
              and(
                ne(referralClicks.medium, "paid"),
                gte(referralClicks.clickedAt, organicCutoff),
              ),
            ),
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

import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNotNull, sql, sum } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Database, invites, unlocks, workerProfiles, workers } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
// TEMPORARY: swap to `@badabhai/db` once the sibling migration lands (see the file header).
import { referralBonusAccruals, type ReferralBonusAccrual } from "./referral-bonus.table";

/** The attributing worker→worker invite for a referred worker (opaque ids only). */
export interface AttributingInvite {
  inviteId: string;
  inviterWorkerId: string | null;
}

/** Aggregate ledger view (ops). Counts + whole rupees — never a worker id. */
export interface ReferralBonusTotals {
  accrual_count: number;
  total_inr: number;
}

/**
 * Data access for the MOCK ₹20 activation-bonus ledger (§X.6) and for the two facts the
 * qualification rule reads (a CONFIRMED profile, a GRANTED unlock).
 *
 * PHONE HASHES NEVER LEAVE THE DATABASE. The fraud rule needs two phone-hash comparisons
 * (inviter-vs-invited, and invited-vs-anyone-already-paid), and both are expressed as SQL
 * JOINS ON `workers.phone_hash` that return a BOOLEAN. The hash is therefore never selected,
 * never returned, never held in a variable, and never loggable — which is a stronger
 * guarantee than "we remember not to log it", and keeps invariant #2 structural. Only
 * `workers` may hold the hash; nothing here copies it out.
 */
@Injectable()
export class ReferralBonusRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The worker→worker invite that attributed this worker, if any. The AGENCY funnel is
   * deliberately NOT consulted: an agency's reward is the separate commission ledger
   * (`agency_payout.*`), and paying both would pay twice for one supply event.
   */
  async findAttributingInvite(invitedWorkerId: string): Promise<AttributingInvite | undefined> {
    const [row] = await this.db
      .select({ inviteId: invites.id, inviterWorkerId: invites.inviterWorkerId })
      .from(invites)
      .where(eq(invites.invitedWorkerId, invitedWorkerId))
      .limit(1);
    return row;
  }

  /** Leg 1 of the rule: the referred worker CONFIRMED their profile (not merely extracted). */
  async hasConfirmedProfile(workerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: workerProfiles.id })
      .from(workerProfiles)
      .where(
        and(eq(workerProfiles.workerId, workerId), eq(workerProfiles.profileStatus, "confirmed")),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Leg 2 of the rule: at least one unlock was GRANTED on the referred worker — i.e. a
   * paying party wanted their contact. Keyed on `granted_at IS NOT NULL`, NOT on
   * `status='granted'`: the status moves on afterwards (`revealed`, and eventually
   * `expired`), so matching the status alone would silently stop qualifying workers whose
   * unlock was actually used — the strongest possible signal of a real referral.
   */
  async hasGrantedUnlock(workerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: unlocks.id })
      .from(unlocks)
      .where(and(eq(unlocks.workerId, workerId), isNotNull(unlocks.grantedAt)))
      .limit(1);
    return rows.length > 0;
  }

  /** Has this referred worker already earned a bonus? (The UNIQUE column is the real gate.) */
  async findAccrualByInvitedWorker(
    invitedWorkerId: string,
  ): Promise<ReferralBonusAccrual | undefined> {
    const [row] = await this.db
      .select()
      .from(referralBonusAccruals)
      .where(eq(referralBonusAccruals.invitedWorkerId, invitedWorkerId))
      .limit(1);
    return row;
  }

  /**
   * FRAUD CHECK A — do the inviter and the invited worker share a phone hash? (The classic
   * "invite yourself from a second handset / re-registered number" farm.) A SQL self-join on
   * `workers.phone_hash` returning a boolean: the hash is compared in the database and never
   * materializes in this process.
   */
  async sharesPhoneHash(inviterWorkerId: string, invitedWorkerId: string): Promise<boolean> {
    const inviter = alias(workers, "inviter_w");
    const invited = alias(workers, "invited_w");
    const rows = await this.db
      .select({ hit: sql<number>`1` })
      .from(inviter)
      .innerJoin(invited, eq(invited.phoneHash, inviter.phoneHash))
      .where(and(eq(inviter.id, inviterWorkerId), eq(invited.id, invitedWorkerId)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * FRAUD CHECK B — has the invited worker's PHONE already earned a bonus under some other
   * worker row? (Delete the account, re-register the same number, get referred again.) The
   * UNIQUE constraint only stops a repeat on the same worker id, so the phone is the
   * durable identity here. Again a pure-SQL join: no hash crosses the boundary.
   */
  async phoneAlreadyEarned(invitedWorkerId: string): Promise<boolean> {
    const earner = alias(workers, "earner_w");
    const candidate = alias(workers, "candidate_w");
    const rows = await this.db
      .select({ hit: sql<number>`1` })
      .from(referralBonusAccruals)
      .innerJoin(earner, eq(earner.id, referralBonusAccruals.invitedWorkerId))
      .innerJoin(candidate, eq(candidate.phoneHash, earner.phoneHash))
      .where(eq(candidate.id, invitedWorkerId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Accrue the bonus. `ON CONFLICT (invited_worker_id) DO NOTHING` makes the DATABASE the
   * idempotency authority — two concurrent qualifications for the same referred worker
   * produce exactly one row, and the loser gets `undefined` (so it emits no event). This is
   * the "one bonus per referred worker, ever" rule; nothing depends on a read-then-write.
   */
  async accrue(input: {
    inviterWorkerId: string;
    invitedWorkerId: string;
    amountInr: number;
    qualifiedAt: Date;
  }): Promise<ReferralBonusAccrual | undefined> {
    const [row] = await this.db
      .insert(referralBonusAccruals)
      .values({
        inviterWorkerId: input.inviterWorkerId,
        invitedWorkerId: input.invitedWorkerId,
        amountInr: input.amountInr,
        qualifiedAt: input.qualifiedAt,
      })
      .onConflictDoNothing({ target: referralBonusAccruals.invitedWorkerId })
      .returning();
    return row;
  }

  /** Ledger totals for ops. AGGREGATE-ONLY — rows/ids never leave this method. */
  async totals(): Promise<ReferralBonusTotals> {
    const [row] = await this.db
      .select({ n: count(), total: sum(referralBonusAccruals.amountInr) })
      .from(referralBonusAccruals);
    return {
      accrual_count: Number(row?.n ?? 0),
      // `sum()` is a numeric string (or null on an empty table) in postgres.
      total_inr: Number(row?.total ?? 0),
    };
  }
}

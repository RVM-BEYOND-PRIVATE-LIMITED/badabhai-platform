import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, isNotNull, isNull, sql, sum } from "drizzle-orm";
import {
  type Database,
  agencyInvites,
  agencyPayoutAccruals,
  agencyPayoutRequests,
  unlocks,
  type AgencyPayoutAccrual,
  type AgencyPayoutRequest,
  type AgencyKycStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One granted unlock that qualifies for a commission accrual (the join off real unlock data). */
export interface QualifyingUnlock {
  unlockId: string;
  grantedAt: Date;
  attributedAt: Date;
}

/** Aggregate earnings for one agency (₹, whole rupees) — the analytics off real accrual data. */
export interface AgencyEarningsAgg {
  totalAccruedInr: number;
  requestableInr: number; // unclaimed accruals (available to request)
  inRequestInr: number; // claimed into a 'requested' (mock-pending) payout
  paidInr: number; // claimed into a 'paid' (mock-settled) payout
  accrualCount: number;
}

/** Thrown to ROLL BACK the claim tx when the claimable total is below the ₹ threshold. */
export class PayoutBelowThresholdError extends Error {
  constructor(public readonly pendingInr: number) {
    super("payout below threshold");
    this.name = "PayoutBelowThresholdError";
  }
}

/**
 * Data access for the agency payout ledger (ADR-0022 Amendment 2). PII-FREE: ₹ + opaque ids.
 * The accrual source is the REAL `unlocks` table (granted unlocks = the revenue events) joined
 * to `agency_invites` (the agency's attributed workers) within the 90-day window; accruals are
 * idempotent per unlock (UNIQUE source_unlock_id). Claiming into a payout request is a race-safe
 * transaction (the `payout_request_id IS NULL` UPDATE atomically claims; a concurrent request
 * gets the disjoint remainder).
 */
@Injectable()
export class AgencyPayoutRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The join off real unlock data: every GRANTED unlock on a worker THIS agency referred
   * (`agency_invites.invited_worker_id`), whose `granted_at` falls within `windowDays` of the
   * invite's `attributed_at`. Nulls never match (both sides filtered NOT NULL).
   */
  async findQualifyingUnlocks(agencyId: string, windowDays: number): Promise<QualifyingUnlock[]> {
    const rows = await this.db
      .select({
        unlockId: unlocks.id,
        grantedAt: unlocks.grantedAt,
        attributedAt: agencyInvites.attributedAt,
      })
      .from(agencyInvites)
      .innerJoin(unlocks, eq(unlocks.workerId, agencyInvites.invitedWorkerId))
      .where(
        and(
          eq(agencyInvites.inviterPayerId, agencyId),
          isNotNull(agencyInvites.invitedWorkerId),
          isNotNull(agencyInvites.attributedAt),
          eq(unlocks.status, "granted"),
          isNotNull(unlocks.grantedAt),
          sql`${unlocks.grantedAt} >= ${agencyInvites.attributedAt}`,
          sql`${unlocks.grantedAt} <= ${agencyInvites.attributedAt} + make_interval(days => ${windowDays})`,
        ),
      );
    // Non-null asserted: the WHERE filters both timestamps NOT NULL.
    return rows.map((r) => ({
      unlockId: r.unlockId,
      grantedAt: r.grantedAt as Date,
      attributedAt: r.attributedAt as Date,
    }));
  }

  /**
   * Insert accruals idempotently (ON CONFLICT (source_unlock_id) DO NOTHING). Returns ONLY the
   * rows actually inserted, so the caller emits `agency_payout.accrued` exactly once per accrual.
   */
  async insertAccruals(
    rows: Array<{
      agencyPayerId: string;
      sourceUnlockId: string;
      basisInr: number;
      rateBps: number;
      amountInr: number;
      unlockGrantedAt: Date;
      attributedAt: Date;
    }>,
  ): Promise<AgencyPayoutAccrual[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(agencyPayoutAccruals)
      .values(rows)
      .onConflictDoNothing({ target: agencyPayoutAccruals.sourceUnlockId })
      .returning();
  }

  /** Aggregate earnings for the agency (off the real accrual + request rows). */
  async aggregate(agencyId: string): Promise<AgencyEarningsAgg> {
    const [tot] = await this.db
      .select({ total: sum(agencyPayoutAccruals.amountInr), n: count() })
      .from(agencyPayoutAccruals)
      .where(eq(agencyPayoutAccruals.agencyPayerId, agencyId));

    const [req] = await this.db
      .select({ requestable: sum(agencyPayoutAccruals.amountInr) })
      .from(agencyPayoutAccruals)
      .where(
        and(
          eq(agencyPayoutAccruals.agencyPayerId, agencyId),
          isNull(agencyPayoutAccruals.payoutRequestId),
        ),
      );

    const byStatus = await this.db
      .select({ status: agencyPayoutRequests.status, total: sum(agencyPayoutRequests.amountInr) })
      .from(agencyPayoutRequests)
      .where(eq(agencyPayoutRequests.agencyPayerId, agencyId))
      .groupBy(agencyPayoutRequests.status);

    const n = (v: string | null): number => Number(v ?? 0);
    let inRequestInr = 0;
    let paidInr = 0;
    for (const r of byStatus) {
      if (r.status === "requested") inRequestInr = n(r.total);
      else if (r.status === "paid") paidInr = n(r.total);
    }
    return {
      totalAccruedInr: n(tot?.total ?? null),
      requestableInr: n(req?.requestable ?? null),
      inRequestInr,
      paidInr,
      accrualCount: Number(tot?.n ?? 0),
    };
  }

  /** The agency's OWN payout requests (ids / ₹ / status only). */
  async listRequests(agencyId: string): Promise<AgencyPayoutRequest[]> {
    return this.db
      .select()
      .from(agencyPayoutRequests)
      .where(eq(agencyPayoutRequests.agencyPayerId, agencyId))
      .orderBy(desc(agencyPayoutRequests.createdAt));
  }

  /**
   * Create a payout request and ATOMICALLY claim the agency's currently-unclaimed accruals into
   * it. Race-safe: the `payout_request_id IS NULL` UPDATE claims a disjoint set, so two
   * concurrent requests never double-count. If the claimed total is below `thresholdInr` (or
   * nothing is claimable), the whole tx ROLLS BACK via {@link PayoutBelowThresholdError} — no
   * request row and no claim survive. Returns the finalized request on success.
   */
  async createRequestClaiming(input: {
    agencyId: string;
    kycStatus: AgencyKycStatus;
    thresholdInr: number;
    idempotencyKey: string;
  }): Promise<AgencyPayoutRequest> {
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .insert(agencyPayoutRequests)
        .values({
          agencyPayerId: input.agencyId,
          amountInr: 0,
          accrualCount: 0,
          status: "requested",
          kycSnapshotStatus: input.kycStatus,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!request) throw new Error("failed to create payout request");

      const claimed = await tx
        .update(agencyPayoutAccruals)
        .set({ payoutRequestId: request.id })
        .where(
          and(
            eq(agencyPayoutAccruals.agencyPayerId, input.agencyId),
            isNull(agencyPayoutAccruals.payoutRequestId),
          ),
        )
        .returning({ amountInr: agencyPayoutAccruals.amountInr });

      const amountInr = claimed.reduce((s, r) => s + r.amountInr, 0);
      const accrualCount = claimed.length;
      if (accrualCount === 0 || amountInr < input.thresholdInr) {
        // Below threshold (or a concurrent request already claimed everything) — roll back
        // the request + the claim entirely by throwing out of the transaction.
        throw new PayoutBelowThresholdError(amountInr);
      }

      const [finalized] = await tx
        .update(agencyPayoutRequests)
        .set({ amountInr, accrualCount, updatedAt: new Date() })
        .where(eq(agencyPayoutRequests.id, request.id))
        .returning();
      if (!finalized) throw new Error("failed to finalize payout request");
      return finalized;
    });
  }
}

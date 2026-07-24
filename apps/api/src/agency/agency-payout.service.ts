import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { AgencyKycStatus, AgencyPayoutRequest } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { AgencyKycService } from "./agency-kyc.service";
import {
  AgencyPayoutRepository,
  PayoutBelowThresholdError,
  type AgencyEarningsAgg,
} from "./agency-payout.repository";

type BlockedReason = PayloadInputOf<"agency_payout.blocked">["reason"];

/** Aggregate earnings + the gate state for the agency's own analytics view. */
export interface AgencyEarningsView extends AgencyEarningsAgg {
  kycStatus: AgencyKycStatus | "not_submitted";
  thresholdInr: number;
  basisInr: number;
  rateBps: number;
  windowDays: number;
  payoutsEnabled: boolean;
  canRequest: boolean;
  /** Why a request would be refused right now (null when `canRequest`). A CODE, not PII. */
  blockedReason: BlockedReason | null;
}

/** Outcome of a payout request — the gate is the ONLY way state changes. */
export type PayoutRequestOutcome =
  | { ok: true; requestId: string; amountInr: number; accrualCount: number }
  | { ok: false; blocked: true; reason: BlockedReason };

/**
 * Agency payout ledger (ADR-0022 modules 3+7, Amendment 2) — the owner-ratified MOCK supply
 * money loop, all economics from config (`25% × ₹40 / 90d / ₹500`):
 *  - {@link recomputeAccruals}: idempotently accrue `rate × basis` per GRANTED unlock on a
 *    referred worker within the window (off the real `unlocks` table). Emits `agency_payout.accrued`.
 *  - {@link getEarnings}: aggregate analytics off real accrual data + the gate state.
 *  - {@link requestPayout}: the GATE. Provably unreachable unless (a) `AGENCY_PAYOUTS_ENABLED`
 *    is ON, (b) KYC status is `verified`, and (c) the requestable total ≥ the ₹ threshold. Any
 *    failure emits `agency_payout.blocked` and changes NO state. Success claims the accruals
 *    into a `requested` (MOCK — no disbursement) row and emits `agency_payout.requested`.
 */
@Injectable()
export class AgencyPayoutService {
  constructor(
    private readonly repo: AgencyPayoutRepository,
    private readonly kyc: AgencyKycService,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** ₹ accrued per qualifying unlock (floor of basis × rate). Owner-ratified default = ₹10. */
  private accrualAmountInr(): number {
    return Math.floor(
      (this.config.AGENCY_PAYOUT_UNLOCK_BASIS_INR * this.config.AGENCY_PAYOUT_RATE_BPS) / 10000,
    );
  }

  /**
   * Idempotently create accruals for every currently-qualifying granted unlock. Safe to call on
   * every earnings read / payout attempt — ON CONFLICT (source_unlock_id) DO NOTHING means an
   * already-accrued unlock is skipped, so events fire exactly once. Returns the count of NEW accruals.
   */
  async recomputeAccruals(agencyId: string): Promise<number> {
    const basisInr = this.config.AGENCY_PAYOUT_UNLOCK_BASIS_INR;
    const rateBps = this.config.AGENCY_PAYOUT_RATE_BPS;
    const amountInr = this.accrualAmountInr();
    const qualifying = await this.repo.findQualifyingUnlocks(
      agencyId,
      this.config.AGENCY_PAYOUT_WINDOW_DAYS,
    );
    const inserted = await this.repo.insertAccruals(
      qualifying.map((q) => ({
        agencyPayerId: agencyId,
        sourceUnlockId: q.unlockId,
        basisInr,
        rateBps,
        amountInr,
        unlockGrantedAt: q.grantedAt,
        attributedAt: q.attributedAt,
      })),
    );
    for (const a of inserted) {
      const payload: PayloadInputOf<"agency_payout.accrued"> = {
        agency_payer_id: agencyId,
        unlock_id: a.sourceUnlockId,
        amount_inr: a.amountInr,
        basis_inr: a.basisInr,
        rate_bps: a.rateBps,
      };
      await this.events.emit({
        event_name: "agency_payout.accrued",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "unlock", subject_id: a.sourceUnlockId },
        payload,
        idempotencyKey: `agency_payout.accrued:${a.sourceUnlockId}`,
      });
    }
    return inserted.length;
  }

  /** Earnings analytics off REAL accrual data + the current gate state. Recomputes first. */
  async getEarnings(agencyId: string): Promise<AgencyEarningsView> {
    await this.recomputeAccruals(agencyId);
    const agg = await this.repo.aggregate(agencyId);
    const kycStatus = await this.kyc.statusForGate(agencyId);
    const thresholdInr = this.config.AGENCY_PAYOUT_MIN_THRESHOLD_INR;
    const payoutsEnabled = this.config.AGENCY_PAYOUTS_ENABLED;

    let blockedReason: BlockedReason | null = null;
    if (!payoutsEnabled) blockedReason = "disabled";
    else if (kycStatus !== "verified") blockedReason = "kyc_not_verified";
    else if (agg.requestableInr < thresholdInr) blockedReason = "below_threshold";

    return {
      ...agg,
      kycStatus: kycStatus ?? "not_submitted",
      thresholdInr,
      basisInr: this.config.AGENCY_PAYOUT_UNLOCK_BASIS_INR,
      rateBps: this.config.AGENCY_PAYOUT_RATE_BPS,
      windowDays: this.config.AGENCY_PAYOUT_WINDOW_DAYS,
      payoutsEnabled,
      canRequest: blockedReason === null,
      blockedReason,
    };
  }

  /**
   * The payout GATE. KYC-verified + ≥ threshold are BOTH required; a failure emits
   * `agency_payout.blocked` and changes nothing (the KYC gate is provably unreachable-to-request
   * without a verified row). On pass, claims the unclaimed accruals into a MOCK `requested` row.
   */
  async requestPayout(agencyId: string): Promise<PayoutRequestOutcome> {
    // Defense-in-depth: the controller already 404s when the flag is OFF, but never proceed.
    if (!this.config.AGENCY_PAYOUTS_ENABLED) {
      return this.blocked(agencyId, "disabled", 0);
    }
    await this.recomputeAccruals(agencyId);
    const kycStatus = await this.kyc.statusForGate(agencyId);
    const agg = await this.repo.aggregate(agencyId);

    // GATE 1 — KYC must be verified. This is the bypass-tested chokepoint.
    if (kycStatus !== "verified") {
      return this.blocked(agencyId, "kyc_not_verified", agg.requestableInr);
    }
    // GATE 2 — requestable total must clear the ₹ threshold.
    const thresholdInr = this.config.AGENCY_PAYOUT_MIN_THRESHOLD_INR;
    if (agg.requestableInr < thresholdInr) {
      return this.blocked(agencyId, "below_threshold", agg.requestableInr);
    }

    try {
      const request = await this.repo.createRequestClaiming({
        agencyId,
        kycStatus,
        thresholdInr,
        idempotencyKey: randomUUID(),
      });
      await this.emitRequested(agencyId, request);
      return {
        ok: true,
        requestId: request.id,
        amountInr: request.amountInr,
        accrualCount: request.accrualCount,
      };
    } catch (err) {
      // A concurrent request claimed everything between the pre-check and the tx → treat as
      // below-threshold (the tx rolled back; nothing changed).
      if (err instanceof PayoutBelowThresholdError) {
        return this.blocked(agencyId, "below_threshold", err.pendingInr);
      }
      throw err;
    }
  }

  private async blocked(
    agencyId: string,
    reason: BlockedReason,
    pendingInr: number,
  ): Promise<PayoutRequestOutcome> {
    const payload: PayloadInputOf<"agency_payout.blocked"> = {
      agency_payer_id: agencyId,
      reason,
      amount_inr: pendingInr,
    };
    await this.events.emit({
      event_name: "agency_payout.blocked",
      actor: { actor_type: "agent", actor_id: agencyId },
      subject: { subject_type: "payer", subject_id: agencyId },
      payload,
    });
    return { ok: false, blocked: true, reason };
  }

  private async emitRequested(agencyId: string, request: AgencyPayoutRequest): Promise<void> {
    const payload: PayloadInputOf<"agency_payout.requested"> = {
      agency_payer_id: agencyId,
      payout_request_id: request.id,
      amount_inr: request.amountInr,
      accrual_count: request.accrualCount,
    };
    await this.events.emit({
      event_name: "agency_payout.requested",
      actor: { actor_type: "agent", actor_id: agencyId },
      subject: { subject_type: "agency_payout_request", subject_id: request.id },
      payload,
      idempotencyKey: `agency_payout.requested:${request.id}`,
    });
  }

  /** The agency's OWN payout request history (ids / ₹ / status). */
  async listRequests(agencyId: string): Promise<AgencyPayoutRequest[]> {
    return this.repo.listRequests(agencyId);
  }
}

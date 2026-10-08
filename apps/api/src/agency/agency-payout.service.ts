import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { AgencyKycStatus, AgencyPayoutRequest, Database } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
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
 *
 * ORG-LEVEL (ADR-0053 PAY-DB-01 P2d, owner ruling O-5): the agency is the ORG. Each entry point
 * ({@link getEarnings}, {@link requestPayout}, {@link listRequests}) resolves the session payer's
 * tenancy ONCE; the TENANT KEY keys the accruals, the requests and the KYC gate read (so a
 * teammate's referral earns for the org), and the acting login is the event actor
 * (`agency_payout.blocked` / `.requested`). Who may reach them is the route's decision:
 * `AgencyPayoutsController` admits the org's OWNER only. Org tenancy off: the key is the session
 * payer, today's behaviour exactly.
 */
@Injectable()
export class AgencyPayoutService {
  constructor(
    private readonly repo: AgencyPayoutRepository,
    private readonly kyc: AgencyKycService,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // ADR-0053 — the payer tenant resolver (PayersModule, already imported for the guards).
    private readonly tenancy: PayerTenantScopeService,
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
   *
   * #1129 item 3 — the insert AND every `agency_payout.accrued` it produces commit on ONE
   * transaction (must-fix H3 pattern). Before this, the insert committed and the events were
   * emitted afterward, outside any transaction: a crash (or a validation throw inside `emit`)
   * between the two left committed ledger rows with NO corresponding event, permanently — a
   * retry would skip them (`ON CONFLICT DO NOTHING`) and never re-attempt the emit. Now either
   * the whole batch (every new accrual row + every one of its events) commits, or none of it
   * does, and a retry after a rollback re-inserts + re-emits the full batch cleanly.
   *
   * Takes the TENANT KEY its caller resolved (never re-resolved here): the accruals belong to
   * the org whose invites referred the worker. `agency_payout.accrued` is a system fact
   * (actor `system`), so it needs no acting login.
   */
  async recomputeAccruals(tenant: TenantKey): Promise<number> {
    const basisInr = this.config.AGENCY_PAYOUT_UNLOCK_BASIS_INR;
    const rateBps = this.config.AGENCY_PAYOUT_RATE_BPS;
    const amountInr = this.accrualAmountInr();
    const qualifying = await this.repo.findQualifyingUnlocks(
      tenant,
      this.config.AGENCY_PAYOUT_WINDOW_DAYS,
    );
    if (qualifying.length === 0) return 0; // nothing to insert — no transaction needed

    return this.repo.withTransaction(async (tx) => {
      const inserted = await this.repo.insertAccruals(
        qualifying.map((q) => ({
          agencyPayerId: tenant,
          sourceUnlockId: q.unlockId,
          basisInr,
          rateBps,
          amountInr,
          unlockGrantedAt: q.grantedAt,
          attributedAt: q.attributedAt,
        })),
        tx,
      );
      for (const a of inserted) {
        const payload: PayloadInputOf<"agency_payout.accrued"> = {
          agency_payer_id: tenant,
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
          tx,
        });
      }
      return inserted.length;
    });
  }

  /** The org's earnings off REAL accrual data + the current gate state. Recomputes first. */
  async getEarnings(actorPayerId: string): Promise<AgencyEarningsView> {
    const { tenantKey } = await this.tenancy.resolve(actorPayerId);
    await this.recomputeAccruals(tenantKey);
    const agg = await this.repo.aggregate(tenantKey);
    const kycStatus = await this.kyc.statusForGate(tenantKey);
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
   *
   * #1129 item 3 — the claim (`createRequestClaiming`) and its `agency_payout.requested` emit run
   * on ONE transaction (must-fix H3 pattern): before this, the claim committed and the emit ran
   * afterward, so a crash (or an emit throw) between the two could leave a claimed, money-moving
   * request row with no audit event. Now an emit failure rolls the claim back too — the request
   * row and its claimed accruals revert to unclaimed, exactly as if the request never happened.
   */
  async requestPayout(actorPayerId: string): Promise<PayoutRequestOutcome> {
    const scope = await this.tenancy.resolve(actorPayerId);
    // Defense-in-depth: the controller already 404s when the flag is OFF, but never proceed.
    if (!this.config.AGENCY_PAYOUTS_ENABLED) {
      return this.blocked(scope, "disabled", 0);
    }
    const tenant = scope.tenantKey;
    await this.recomputeAccruals(tenant);
    const kycStatus = await this.kyc.statusForGate(tenant);
    const agg = await this.repo.aggregate(tenant);

    // GATE 1 — KYC must be verified. This is the bypass-tested chokepoint.
    if (kycStatus !== "verified") {
      return this.blocked(scope, "kyc_not_verified", agg.requestableInr);
    }
    // GATE 2 — requestable total must clear the ₹ threshold.
    const thresholdInr = this.config.AGENCY_PAYOUT_MIN_THRESHOLD_INR;
    if (agg.requestableInr < thresholdInr) {
      return this.blocked(scope, "below_threshold", agg.requestableInr);
    }

    try {
      const request = await this.repo.withTransaction(async (tx) => {
        const claimed = await this.repo.createRequestClaiming(
          { tenant, kycStatus, thresholdInr, idempotencyKey: randomUUID() },
          tx,
        );
        await this.emitRequested(scope, claimed, tx);
        return claimed;
      });
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
        return this.blocked(scope, "below_threshold", err.pendingInr);
      }
      throw err;
    }
  }

  /** ADR-0053 §7: actor = the acting login; `agency_payer_id` and the subject = the tenant. */
  private async blocked(
    scope: PayerTenantScope,
    reason: BlockedReason,
    pendingInr: number,
  ): Promise<PayoutRequestOutcome> {
    const payload: PayloadInputOf<"agency_payout.blocked"> = {
      agency_payer_id: scope.tenantKey,
      reason,
      amount_inr: pendingInr,
    };
    await this.events.emit({
      event_name: "agency_payout.blocked",
      actor: { actor_type: "agent", actor_id: scope.actorPayerId },
      subject: { subject_type: "payer", subject_id: scope.tenantKey },
      payload,
    });
    return { ok: false, blocked: true, reason };
  }

  /**
   * `tx` (#1129 item 3): rides the SAME transaction as the claim — see {@link requestPayout}.
   * ADR-0053 §7: actor = the acting login; `agency_payer_id` = the tenant.
   */
  private async emitRequested(
    scope: PayerTenantScope,
    request: AgencyPayoutRequest,
    tx: Database,
  ): Promise<void> {
    const payload: PayloadInputOf<"agency_payout.requested"> = {
      agency_payer_id: scope.tenantKey,
      payout_request_id: request.id,
      amount_inr: request.amountInr,
      accrual_count: request.accrualCount,
    };
    await this.events.emit({
      event_name: "agency_payout.requested",
      actor: { actor_type: "agent", actor_id: scope.actorPayerId },
      subject: { subject_type: "agency_payout_request", subject_id: request.id },
      payload,
      idempotencyKey: `agency_payout.requested:${request.id}`,
      tx,
    });
  }

  /** The org's OWN payout request history (ids / ₹ / status). */
  async listRequests(actorPayerId: string): Promise<AgencyPayoutRequest[]> {
    const { tenantKey } = await this.tenancy.resolve(actorPayerId);
    return this.repo.listRequests(tenantKey);
  }
}

import { ConflictException, Injectable } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { AgencyKyc, AgencyKycStatus } from "@badabhai/db";
import { EventsService } from "../events/events.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayersRepository } from "../payers/payers.repository";
import { AgencyKycRepository } from "./agency-kyc.repository";
import type { SubmitAgencyKycDto } from "./agency-kyc.dto";

/**
 * The agency-facing (owner or ops) view of a KYC row — MASKED ONLY. Full PAN / bank / IFSC
 * NEVER leave the encrypted store: the only derivatives that cross this boundary are the
 * status enum + the last-4 of the PAN and bank account (a transient own-view decrypt, the
 * same pattern as `PayersRepository.decryptContact`). There is deliberately NO endpoint,
 * for any principal, that returns the full financial PII.
 */
export interface AgencyKycView {
  status: AgencyKycStatus | "not_submitted";
  panLast4: string | null;
  bankLast4: string | null;
  rejectReason: string | null;
  updatedAt: Date | null;
}

/** Ops queue row — the agency payer id + the SAME masked projection (last-4 only). */
export interface AgencyKycOpsRow extends AgencyKycView {
  payerId: string;
  submittedAt: Date;
}

/** Postgres unique-violation (23505) — here, a cross-agency duplicate PAN hash. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Agency KYC (ADR-0022 module 1, Amendment 2). Owns the financial-PII boundary for the agency
 * supply-money loop:
 *  - SUBMIT encrypts PAN/bank/IFSC/holder-name at rest (ADR-0004 discipline, `PiiCryptoService`)
 *    and emits `agency_kyc.submitted` (payer_id + status ONLY — no PAN/bank in the event).
 *  - Reads are MASKED (last-4) via a transient own-view/ops decrypt; full values never egress.
 *  - VERIFY / REJECT are ops-only (mock human ack — no real registry check; real verification
 *    is the legal/§7 launch gate) and emit `agency_kyc.verified` / `agency_kyc.rejected`.
 *  - {@link statusForGate} is the payout gate's read: the payout path is unreachable unless
 *    this returns `'verified'`.
 */
@Injectable()
export class AgencyKycService {
  constructor(
    private readonly repo: AgencyKycRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    // ADR-0037 Decision 7 — the lifecycle read. `findAuthFacts` is REUSED from the payer
    // guard rather than adding a status read here: it is already the narrow
    // `{role, status}` projection built for exactly this question, and it deliberately
    // avoids `findById`, which returns the full encrypted-PII row.
    private readonly payers: PayersRepository,
  ) {}

  private static last4(value: string): string {
    return value.length <= 4 ? value : value.slice(-4);
  }

  private toView(row: AgencyKyc | undefined): AgencyKycView {
    if (!row) {
      return { status: "not_submitted", panLast4: null, bankLast4: null, rejectReason: null, updatedAt: null };
    }
    // Transient own-view/ops decrypt → last-4 ONLY. Full plaintext is discarded immediately.
    return {
      status: row.status,
      panLast4: AgencyKycService.last4(this.pii.decrypt(row.panEnc)),
      bankLast4: AgencyKycService.last4(this.pii.decrypt(row.bankAccountEnc)),
      rejectReason: row.rejectReason,
      updatedAt: row.updatedAt,
    };
  }

  /** Submit/replace KYC (encrypt at rest → pending). Emits `agency_kyc.submitted`. Masked view. */
  async submit(payerId: string, dto: SubmitAgencyKycDto): Promise<AgencyKycView> {
    let row: AgencyKyc;
    try {
      row = await this.repo.upsertPending(payerId, {
        panEnc: this.pii.encrypt(dto.pan),
        // Keyed HMAC → dedup: one PAN cannot back multiple agencies (unique index fails closed).
        panHash: this.pii.hmac(dto.pan),
        bankAccountEnc: this.pii.encrypt(dto.bank_account),
        ifscEnc: this.pii.encrypt(dto.ifsc),
        accountHolderNameEnc: this.pii.encrypt(dto.account_holder_name),
      });
    } catch (err) {
      // The payer_id conflict is absorbed by upsert; the only unique that can escape is the
      // cross-agency PAN hash. Surface a NEUTRAL conflict (never "PAN X is taken" — no oracle,
      // no PAN echoed) rather than a raw 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException("These KYC details could not be saved");
      }
      throw err;
    }

    const payload: PayloadInputOf<"agency_kyc.submitted"> = { payer_id: payerId, status: "pending" };
    await this.events.emit({
      event_name: "agency_kyc.submitted",
      actor: { actor_type: "agent", actor_id: payerId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload,
      idempotencyKey: `agency_kyc.submitted:${row.id}:${row.updatedAt.getTime()}`,
    });
    return this.toView(row);
  }

  /** The agency's OWN masked KYC status. */
  async getOwnView(payerId: string): Promise<AgencyKycView> {
    return this.toView(await this.repo.findByPayer(payerId));
  }

  /** The payout-gate read: the raw status enum (null if never submitted). NO decrypt. */
  async statusForGate(payerId: string): Promise<AgencyKycStatus | null> {
    const row = await this.repo.findByPayer(payerId);
    return row?.status ?? null;
  }

  /** Ops queue: pending submissions, masked (last-4 only — no full financial PII to ops). */
  async listPendingForOps(): Promise<AgencyKycOpsRow[]> {
    const rows = await this.repo.listByStatus("pending");
    return rows.map((r) => ({ payerId: r.payerId, submittedAt: r.createdAt, ...this.toView(r) }));
  }

  /**
   * Ops verify (mock human ack — no real registry check; real verification is the legal/§7 launch
   * gate). Emits `agency_kyc.verified` iff it performed the transition. Actor = the `ops`
   * shared-secret principal (apps/web ops console via InternalServiceGuard); no per-person id.
   */
  async verify(payerId: string): Promise<{ ok: boolean }> {
    // ADR-0037 Decision 7 — a suspended agency does not progress through KYC.
    //
    // This is the ONE agency financial route a suspension cannot otherwise reach. Every
    // other one (submit KYC, read earnings, request a payout) sits behind `PayerAuthGuard`,
    // which has required `active` since ADR-0037 — but this is the OPS console under
    // `InternalServiceGuard`, so there is no payer principal for the guard to check.
    //
    // Verifying here is not cosmetic: KYC `verified` is the gate `statusForGate` reads to
    // decide payout eligibility. Verifying a suspended agency arms their cash-out for the
    // instant they are reinstated, or immediately if `AGENCY_PAYOUTS_ENABLED` is flipped on
    // while they are still banned — an ops action taken in one console silently unlocking
    // money in another.
    //
    // REJECT IS DELIBERATELY NOT BLOCKED. Rejecting is restrictive: it takes eligibility
    // away, never grants it, and ops must stay able to clear a fraudulent submission from
    // the queue without first reinstating the account that submitted it.
    const facts = await this.payers.findAuthFacts(payerId);
    if (facts?.status === "suspended") {
      throw new ConflictException("Agency is suspended; KYC cannot be verified");
    }
    const at = await this.repo.markVerified(payerId);
    if (at) {
      const payload: PayloadInputOf<"agency_kyc.verified"> = { payer_id: payerId };
      await this.events.emit({
        event_name: "agency_kyc.verified",
        actor: { actor_type: "ops", actor_id: null },
        subject: { subject_type: "payer", subject_id: payerId },
        payload,
        // Per-DECISION key (payer + transition ts): a re-verify after a KYC resubmit is a NEW
        // genuine decision and must NOT be deduped off the spine (mirrors the submit key).
        idempotencyKey: `agency_kyc.verified:${payerId}:${at.getTime()}`,
      });
    }
    return { ok: at !== null };
  }

  /** Ops reject with a bounded reason CODE. Emits `agency_kyc.rejected` iff it transitioned. */
  async reject(
    payerId: string,
    reason: PayloadInputOf<"agency_kyc.rejected">["reason"],
  ): Promise<{ ok: boolean }> {
    const at = await this.repo.markRejected(payerId, reason);
    if (at) {
      const payload: PayloadInputOf<"agency_kyc.rejected"> = { payer_id: payerId, reason };
      await this.events.emit({
        event_name: "agency_kyc.rejected",
        actor: { actor_type: "ops", actor_id: null },
        subject: { subject_type: "payer", subject_id: payerId },
        payload,
        // Per-DECISION key (payer + transition ts) — a re-reject after resubmit is a new decision.
        idempotencyKey: `agency_kyc.rejected:${payerId}:${at.getTime()}`,
      });
    }
    return { ok: at !== null };
  }
}

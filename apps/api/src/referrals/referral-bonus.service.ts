import { Injectable, Logger } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { EventsService } from "../events/events.service";
import { ReferralBonusRepository, type ReferralBonusTotals } from "./referral-bonus.repository";

/**
 * Why a referral did NOT accrue. A CLOSED code set — never free text, never a phone, never
 * a hash, and never the counterpart's id. Returned to the internal caller and used in tests;
 * the log line carries the CODE ALONE (see below).
 */
export type BonusDisqualifyReason =
  /** No worker→worker invite ever attributed this worker (includes agency-sourced workers). */
  | "no_referral"
  /** The inviter was hard-deleted (DSAR SET NULL) — there is nobody to owe. */
  | "inviter_unavailable"
  /** Inviter and invited are the same worker (already impossible upstream — see below). */
  | "self_referral"
  /** Leg 1 unmet: the referred worker has not CONFIRMED a profile. */
  | "profile_incomplete"
  /** Leg 2 unmet: nobody has been granted an unlock on the referred worker. */
  | "not_unlocked"
  /** Inviter and invited share a phone, or this phone already earned a bonus. */
  | "duplicate_phone"
  /** This referred worker already has an accrual (the UNIQUE column). */
  | "already_accrued";

export type BonusOutcome =
  | { accrued: true; accrual_id: string; amount_inr: number }
  | { accrued: false; reason: BonusDisqualifyReason };

/**
 * §X.6 — the ₹20 worker-referral ACTIVATION BONUS, and the fraud rule that makes it safe.
 *
 * THE RULE (the plan's single most valuable fraud control): pay ONLY when a referred worker
 * has BOTH completed a profile AND been unlocked by a paying party. Neither leg can be
 * manufactured for free — the second one requires somebody to spend money on the referred
 * worker — so the referral-farm economics are dead before they start. Accrual therefore
 * happens on NEITHER click, NOR install, NOR upload: those prove nothing.
 *
 * MOCK LEDGER, NO DISBURSEMENT. Nothing pays out in this release — this mirrors the agency
 * payout posture (ADR-0022 Amendment 2: accrue now, disburse behind a launch gate) and
 * CLAUDE.md §7/§8, where real outbound money is a human gate. There is deliberately no
 * "pay" method and no `referral.bonus_paid` event.
 *
 * IDEMPOTENCY is the DATABASE's, not this service's: `referral_bonus_accruals` is UNIQUE on
 * `invited_worker_id`, and the insert is `ON CONFLICT DO NOTHING`. No row written ⇒ no event
 * emitted. That holds under concurrency and across restarts, which a read-then-write check
 * would not.
 *
 * SELF-REFERRAL is NOT re-implemented here. `InviteService.recordAccept` is the single
 * owner of that rule and refuses to attribute an invite to its own inviter, so an invite
 * that could self-refer never reaches `accepted` and can never reach this service. The
 * equality test below is a fail-closed ASSERTION of that upstream invariant (one cheap
 * comparison on data already loaded), not a second implementation of the rule.
 *
 * PRIVACY: this service never sees a phone hash — both hash comparisons are SQL joins in
 * the repository that return booleans. The log line carries the reason CODE only, with no
 * ids at all: "worker X was disqualified for duplicate_phone" would itself be a statement
 * about a relationship between two people, so it is not written.
 */
@Injectable()
export class ReferralBonusService {
  private readonly logger = new Logger(ReferralBonusService.name);

  /**
   * The activation bonus in WHOLE RUPEES (§X.6, "₹20"). A constant, not config: it is a
   * product parameter of the fraud rule, and the accrued rows are a ledger — a value that
   * could drift per-environment would make historical rows unexplainable. Moving it into the
   * pricing catalog belongs with the (deferred) disbursement rail, not with the mock ledger.
   */
  static readonly BONUS_INR = 20;

  constructor(
    private readonly repo: ReferralBonusRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * Evaluate the referred worker against the rule and accrue AT MOST ONCE.
   *
   * Safe to call as often as you like, from any trigger point (profile confirmation, unlock
   * grant, an ops sweep): it is idempotent, side-effect-free unless BOTH legs hold, and it
   * reads only opaque ids. The intended production trigger points are the profile-confirm
   * and unlock-grant paths; until those call it, this is driven by the internal endpoint.
   */
  async evaluate(invitedWorkerId: string): Promise<BonusOutcome> {
    // 1) Was this worker referred at all? (Worker→worker only — the agency funnel is paid
    //    by its own commission ledger; paying both would pay twice for one supply event.)
    const invite = await this.repo.findAttributingInvite(invitedWorkerId);
    if (!invite) return this.refuse("no_referral");

    const inviterWorkerId = invite.inviterWorkerId;
    // The inviter was hard-deleted (DSAR SET NULL): there is no one to owe, and the event
    // payload requires a non-null uuid. Fail closed rather than emit a half-event.
    if (inviterWorkerId === null) return this.refuse("inviter_unavailable");
    // Fail-closed assertion of the UPSTREAM self-referral rule (owned by InviteService).
    if (inviterWorkerId === invitedWorkerId) return this.refuse("self_referral");

    // 2) Already paid for this worker? (Cheap short-circuit; the UNIQUE column is the gate.)
    if (await this.repo.findAccrualByInvitedWorker(invitedWorkerId)) {
      return this.refuse("already_accrued");
    }

    // 3) THE RULE — both legs, in the cheap-first order. Never on click/install/upload.
    if (!(await this.repo.hasConfirmedProfile(invitedWorkerId))) {
      return this.refuse("profile_incomplete");
    }
    if (!(await this.repo.hasGrantedUnlock(invitedWorkerId))) {
      return this.refuse("not_unlocked");
    }

    // 4) Fraud checks. Both run in SQL and return booleans — no phone hash is read here.
    if (await this.repo.sharesPhoneHash(inviterWorkerId, invitedWorkerId)) {
      return this.refuse("duplicate_phone");
    }
    if (await this.repo.phoneAlreadyEarned(invitedWorkerId)) {
      return this.refuse("duplicate_phone");
    }

    // 5) Accrue. The DB decides: no row back ⇒ someone else won the race ⇒ NO event.
    const row = await this.repo.accrue({
      inviterWorkerId,
      invitedWorkerId,
      amountInr: ReferralBonusService.BONUS_INR,
      qualifiedAt: new Date(),
    });
    if (!row) return this.refuse("already_accrued");

    const payload: PayloadInputOf<"referral.bonus_accrued"> = {
      accrual_id: row.id,
      inviter_worker_id: inviterWorkerId,
      invited_worker_id: invitedWorkerId,
      amount_inr: row.amountInr,
    };
    await this.events.emit({
      event_name: "referral.bonus_accrued",
      // Not worker-triggered: the system observes that the rule became true.
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "referral_bonus", subject_id: row.id },
      payload,
      // One bonus per referred worker, ever — the key states the same rule the UNIQUE
      // constraint enforces, so an at-least-once retry can never double-write the spine.
      idempotencyKey: `referral.bonus_accrued:${invitedWorkerId}`,
    });

    return { accrued: true, accrual_id: row.id, amount_inr: row.amountInr };
  }

  /** Ops read: aggregate ledger totals. No worker ids, no rows — counts + whole rupees. */
  async totals(): Promise<ReferralBonusTotals & { amount_inr_per_referral: number }> {
    const totals = await this.repo.totals();
    return { ...totals, amount_inr_per_referral: ReferralBonusService.BONUS_INR };
  }

  /** Record the reason CODE — deliberately with NO ids (see the class docblock). */
  private refuse(reason: BonusDisqualifyReason): BonusOutcome {
    this.logger.log(`referral bonus not accrued (reason=${reason})`);
    return { accrued: false, reason };
  }
}

import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ReferralBonusService, type BonusOutcome } from "./referral-bonus.service";
import { EvaluateReferralBonusSchema, type EvaluateReferralBonusDto } from "./referral-bonus.dto";

/**
 * MOCK ₹20 activation-bonus surface (§X.6). Thin — the rule, the fraud checks and the event
 * live in {@link ReferralBonusService}.
 *
 * AUTH: both routes ride {@link InternalServiceGuard} (the shared-secret ops/system
 * principal, fail-closed when no token is configured) — matching every other ops-internal
 * surface in this codebase (`/unlocks`, `/pricing`, the agency-KYC ops queue).
 *
 * DELIBERATELY NOT WORKER-FACING. Nothing here is exposed to the worker who is owed the
 * money: this release accrues into a MOCK ledger and disburses NOTHING, and showing a
 * worker "₹20 earned" would be a payment promise the platform cannot yet keep. A
 * worker-facing view belongs with the (deferred, human-gated) disbursement rail.
 *
 * The evaluation is intended to be triggered from the profile-confirm and unlock-grant
 * paths (both outside this module); this endpoint is the driver until that wiring lands,
 * and remains useful as the ops/backfill entry point because the rule is idempotent.
 */
@Controller("referrals")
@UseGuards(InternalServiceGuard)
export class ReferralBonusController {
  constructor(private readonly bonus: ReferralBonusService) {}

  /**
   * Evaluate the rule for one referred worker and accrue if BOTH legs hold. Idempotent:
   * calling it repeatedly accrues at most once (the UNIQUE column decides). Returns the
   * internal outcome + reason CODE — this is an ops principal, not a public surface, so
   * there is no no-oracle constraint here (and no PII in the response either way).
   */
  @Post("bonus/evaluate")
  @HttpCode(200)
  evaluate(
    @Body(new ZodValidationPipe(EvaluateReferralBonusSchema)) dto: EvaluateReferralBonusDto,
  ): Promise<BonusOutcome> {
    return this.bonus.evaluate(dto.invited_worker_id);
  }

  /** Aggregate ledger totals (ops). Counts + whole rupees only — never a worker id. */
  @Get("bonus/summary")
  summary() {
    return this.bonus.totals();
  }
}

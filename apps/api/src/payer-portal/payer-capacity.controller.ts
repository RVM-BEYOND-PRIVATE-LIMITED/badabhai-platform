import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PostingPlansService } from "../posting-plans/posting-plans.service";
import { BuyCapacitySchema, type BuyCapacityDto } from "../posting-plans/posting-plans.dto";

/**
 * Payer-SELF hiring-capacity surface (ADR-0019 + ADR-0016). A payer may view and buy
 * THEIR OWN capacity allowance. DISTINCT from the ops {@link import("../posting-plans/capacity.controller").CapacityController}
 * (InternalServiceGuard, ADVISORY `:payerId` param): this group is behind
 * {@link PayerAuthGuard} and the `payer_id` is ALWAYS the verified session payer
 * (`req.payer.id`) — there is NO `:payerId` param and the body carries NO `payer_id`,
 * so a payer can never act under another payer's id (XB-A, the IDOR guarantee).
 *
 * Thin HTTP only: validation via {@link ZodValidationPipe}; the price resolution, the
 * mock payment (PAYMENTS_ENABLE_REAL=false / real_call honest), the advisory-locked
 * auto-resume, and every capacity/payment spine event live in {@link PostingPlansService},
 * reused unchanged (mirrors how {@link import("./payer-unlocks.controller").PayerUnlocksController}
 * reuses UnlockService). Mock + staging-only; a `bb-security-review` PASS is the pre-merge gate.
 */
@Controller("payer/capacity")
@UseGuards(PayerAuthGuard)
export class PayerCapacityController {
  constructor(private readonly plans: PostingPlansService) {}

  /** The caller's OWN capacity allowance (PII-free: opaque payer_id + counts/codes). */
  @Get()
  ownCapacity(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.plans.getCapacity(payer.id);
  }

  /**
   * Buy/upgrade the caller's OWN capacity. The `payer_id` is the SESSION payer — never
   * a body/param value (XB-A). Delegates to {@link PostingPlansService.buyCapacity},
   * which mock-pays + auto-resumes paused plans + emits the spine events.
   */
  @Post()
  @HttpCode(201)
  buyCapacity(
    @Body(new ZodValidationPipe(BuyCapacitySchema)) dto: BuyCapacityDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.plans.buyCapacity(payer.id, dto, ctx);
  }
}

import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { PostingPlansService } from "./posting-plans.service";
import { BuyPlanSchema, BuyBoostSchema, type BuyPlanDto, type BuyBoostDto } from "./posting-plans.dto";

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B). Payer-facing purchase on
 * a posting. Thin HTTP: validation via ZodValidationPipe, all logic + the mock
 * payment + events in the service.
 *
 * AUTH (LC-1 / TD33): guarded by class-level `InternalServiceGuard` — the same
 * ops/service-to-service posture as {@link CapacityController} and the unlocks
 * money routes. This closes the earlier IDOR vector where these routes were OPEN
 * and trusted `payer_id` from the body: any caller could charge any payer. The
 * `payer_id` in the body remains ADVISORY — the internal-token holder (backend/ops)
 * asserts it; there is no proof the caller IS that payer. A real per-payer
 * `PayerAuthGuard` for the self-serve purchase path is a launch gate (LC-1),
 * mirroring the alpha posture of the capacity/unlock streams. Mock payments only.
 *
 * OPS-ONLY — because `payer_id` is advisory under the shared internal secret, these
 * money routes MUST remain internal/ops-only and MUST NEVER be network-exposed to
 * payers (same contract as {@link UnlocksController}). Client-facing payer purchases
 * ride the per-payer `PayerAuthGuard` `/payer/*` surface instead.
 */
@Controller("job-postings")
@UseGuards(InternalServiceGuard)
export class PostingPlansController {
  constructor(private readonly plans: PostingPlansService) {}

  @Post(":id/plan")
  @HttpCode(201)
  buyPlan(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(BuyPlanSchema)) dto: BuyPlanDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.plans.buyPlan(id, dto, ctx);
  }

  @Post(":id/boost")
  @HttpCode(201)
  buyBoost(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(BuyBoostSchema)) dto: BuyBoostDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.plans.buyBoost(id, dto, ctx);
  }
}

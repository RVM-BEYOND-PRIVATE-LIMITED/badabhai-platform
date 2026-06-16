import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PostingPlansService } from "./posting-plans.service";
import { BuyPlanSchema, BuyBoostSchema, type BuyPlanDto, type BuyBoostDto } from "./posting-plans.dto";

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B). Payer-facing purchase on
 * a posting. Thin HTTP: validation via ZodValidationPipe, all logic + the mock
 * payment + events in the service. No PayerAuthGuard in alpha (launch gate).
 */
@Controller("job-postings")
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

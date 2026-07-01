import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { PostingPlansService } from "./posting-plans.service";
import { BuyPlanSchema, BuyBoostSchema, type BuyPlanDto, type BuyBoostDto } from "./posting-plans.dto";

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B). Thin HTTP: validation via
 * ZodValidationPipe, all logic + the mock payment + events in the service.
 *
 * @deprecated for the PAYER path — SOFT-DEPRECATED by B3 (LC-1). These ops routes trust a
 * body `payer_id` but are guarded by class-level `InternalServiceGuard` (A2 / PR #174, MERGED) —
 * the shared-secret ops posture that closed the earlier OPEN-route IDOR. `payer_id` there stays
 * ADVISORY (an internal-token holder can assert any payer), so they MUST NOT be exposed to
 * external payers (residual internal-only LC-1, tracked TD33/TD50, CLAUDE.md §8). The canonical
 * payer path is now the session-authed {@link import("../payer-portal/payer-job-postings.controller").PayerJobPostingsController}
 * (`POST /payer/job-postings/:id/plan` | `/boost`), where `payer_id` is the verified session
 * payer and the posting is ownership-checked (no-oracle 404). Do not build new payer surface on
 * these routes; they are internal/ops-run support only.
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

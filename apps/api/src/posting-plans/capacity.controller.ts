import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { PostingPlansService } from "./posting-plans.service";
import { BuyCapacitySchema, type BuyCapacityDto } from "./posting-plans.dto";

/**
 * Per-payer hiring capacity (ADR-0016). Buying/upgrading capacity RAISES how many posting
 * plans a payer may hold in status='active' concurrently, then auto-resumes paused plans
 * up to the new allowance. Thin HTTP: validation via ZodValidationPipe; all logic + the
 * mock payment + the advisory-locked auto-resume + events live in the service.
 *
 * AUTH — ADVISORY payer_id caveat (LC-1): guarded by InternalServiceGuard (a SHARED
 * service-to-service secret), NOT per-payer auth. The `:payerId` path param is therefore
 * ADVISORY — the backend/ops holder of the internal token asserts it; there is no proof
 * the caller IS that payer. A real per-payer PayerAuthGuard is a launch gate (LC-1),
 * mirroring the alpha posture of the posting-plan/unlock streams. Mock payments only.
 */
@Controller("payers")
@UseGuards(InternalServiceGuard)
export class CapacityController {
  constructor(private readonly plans: PostingPlansService) {}

  @Post(":payerId/capacity")
  @HttpCode(201)
  buyCapacity(
    @Param("payerId", ParseUUIDPipe) payerId: string,
    @Body(new ZodValidationPipe(BuyCapacitySchema)) dto: BuyCapacityDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.plans.buyCapacity(payerId, dto, ctx);
  }
}

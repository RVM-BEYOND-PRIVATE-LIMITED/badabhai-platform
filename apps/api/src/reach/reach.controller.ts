import { Controller, Get, Param } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ReachService } from "./reach.service";
import { JobIdParamSchema, WorkerIdParamSchema } from "./reach.dto";

/**
 * Reach serving (ADR-0011) — read-only ops views over the deterministic RANK core.
 * Thin HTTP layer: validate the route param, delegate to the service, return its
 * faceless result. Both endpoints emit one `feed.shown` per rendered row (in the
 * service). No auth on the alpha ops surface; no PII anywhere.
 */
@Controller("reach")
export class ReachController {
  constructor(private readonly reach: ReachService) {}

  /** View A — the ranked applicant pool for one job (faceless rows). */
  @Get("jobs/:jobId/applicants")
  applicants(
    @Param(new ZodValidationPipe(JobIdParamSchema)) params: { jobId: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.reach.applicantsForJob(params.jobId, ctx);
  }

  /** View B — the ranked job feed for one worker (faceless rows). */
  @Get("workers/:workerId/feed")
  feed(
    @Param(new ZodValidationPipe(WorkerIdParamSchema)) params: { workerId: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.reach.feedForWorker(params.workerId, ctx);
  }
}

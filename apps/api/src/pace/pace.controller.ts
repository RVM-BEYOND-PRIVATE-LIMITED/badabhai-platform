import { Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PaceService } from "./pace.service";

const JobIdParamSchema = z.object({ jobId: z.string().uuid() });

/**
 * PACE supply-widening (ADR-0021) — the ops-facing surface. Thin HTTP layer:
 * validate, delegate, return a FACELESS result (opaque job_id + stage + counts only).
 *
 * Alpha posture: rides the same unauthenticated ops-surface as `reach` (no per-actor
 * auth yet — cross-link R22); to be guarded when the ops-console auth lands. Both
 * endpoints are PII-free.
 */
@Controller("pace")
export class PaceController {
  constructor(private readonly pace: PaceService) {}

  /** Ops: start a PACE run for a job. Idempotent; a no-op (started:false) when PACE
   * is disabled. The first widen happens on wave 1 (a delayed job), not synchronously. */
  @Post("jobs/:jobId/start")
  async start(
    @Param(new ZodValidationPipe(JobIdParamSchema)) params: { jobId: string },
    @Ctx() ctx: RequestContext,
  ) {
    const state = await this.pace.startForJob(params.jobId, {
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    return {
      enabled: this.pace.isEnabled(),
      started: state !== null,
      jobId: params.jobId,
      stage: state?.stage ?? null,
    };
  }

  /** Ops intervention surface — jobs whose PACE run raised an alert (faceless rows). */
  @Get("alerts")
  async alerts() {
    const rows = await this.pace.listOpsAlerts();
    return {
      alerts: rows.map((r) => ({
        jobId: r.jobId,
        stage: r.stage,
        supplyCount: r.lastSupplyCount,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
      })),
    };
  }
}

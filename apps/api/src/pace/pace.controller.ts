import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PaceService } from "./pace.service";

const JobIdParamSchema = z.object({ jobId: z.string().uuid() });

/**
 * PACE supply-widening (ADR-0021) — the ops-facing surface. Thin HTTP layer:
 * validate, delegate, return a FACELESS result (opaque job_id + stage + counts only).
 *
 * POSTURE: ops-internal, `InternalServiceGuard` (2026-08-01). This docstring used to say
 * PACE "rides the same unauthenticated ops-surface as `reach` … to be guarded when the
 * ops-console auth lands". That condition was met and PACE was missed: `/reach/*`,
 * `/workers/*`, `/events`, `/job-postings/*` and `/pricing/*` were all guarded, and these
 * two were left as the only unauthenticated ops routes in the API.
 *
 * Being PII-free did not make that safe.
 *   - `GET /pace/alerts` was NOT covered by the `PACE_ENABLED` launch gate —
 *     `listOpsAlerts()` never consults `isEnabled()`, so it served live supply
 *     intelligence (which jobs are starving, how thin, for how long) to anyone who
 *     asked. That is the same "faceless, therefore harmless" reasoning that left
 *     `GET /workers` open as a UUID enumeration oracle (R28).
 *   - `POST /pace/jobs/:jobId/start` IS gated by `PACE_ENABLED` and so was inert — but
 *     it is a WRITE that widens a job's reach, i.e. it changes who is shown a job. It
 *     would have armed silently on the flag flip, with no second review at that moment.
 *
 * Both are pinned in `guard-contract.test.ts` and probed by `scripts/prod-canary.mjs`.
 *
 * NOTE: PACE is slated for retirement with the reach-engine (replaced by the zero-reach
 * warning + E12 alert + ops-widen). This guard is not an investment in keeping it — it
 * closes a live gap until that deletion actually happens.
 */
@UseGuards(InternalServiceGuard)
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

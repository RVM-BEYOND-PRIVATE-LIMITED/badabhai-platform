import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { ConsentGuard } from "../auth/consent.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { ActionsService } from "./actions.service";
import {
  WorkerRecordActionSchema,
  WorkerRecordActionsBatchSchema,
  type WorkerRecordActionDto,
  type WorkerRecordActionsBatchDto,
} from "./actions.dto";

/** Redis key namespace for the per-worker hourly cap. Short, and never a worker's own data. */
const RATE_LIMIT_SCOPE = "worker_actions";

/**
 * The worker's OWN behavioural actions, recorded into the event spine (#694, closing #639).
 *
 * WHY THIS EXISTS. `POST /actions` and `POST /actions/batch` sit behind `InternalServiceGuard` —
 * a service-to-service shared secret with no per-worker identity — so a worker client genuinely
 * could not call either. The voice form therefore routed `question_audio_played` and
 * `profiling_answer_spoken` to the Firebase mirror instead, whose own class doc is explicit:
 * *"Mirrors the spine, never replaces it. The audit truth is the server `events` table."*
 *
 * Two things followed from that, and both are what this route repairs:
 *
 *   1. NO VALIDATED EVENT was emitted for either action — nothing landed in `events`, against
 *      CLAUDE.md §3 (Event First).
 *   2. THE SIGNAL WAS UNATTRIBUTABLE. Firebase deliberately carries no join key back to a worker,
 *      so it could never feed the ranking inputs §2.4 names engagement as a first-class signal
 *      for. "This worker cannot read the screen" is only actionable if you know which worker.
 *
 * A DEDICATED CONTROLLER, NOT A METHOD ON `ActionsController`, and that is load-bearing rather
 * than tidy: Nest UNIONS class-level and method-level guards, so a worker route added there would
 * inherit `InternalServiceGuard`, be pulled into `OPS_ROUTES` by `canary-coverage.test.ts`, and
 * then fail prod-canary stage 4 — which sends the ops token and requires a non-401.
 * `WorkerAiJobsController` is the proven precedent for a `@Controller("workers/me/<thing>")` of
 * its own, and for exactly this reason.
 *
 * AUTHZ. `WorkerAuthGuard` then `ConsentGuard`, in that order (CLAUDE.md §2 invariants 4/6) — the
 * posture of every other `/workers/me/*` route. Behavioural profiling of a worker is precisely
 * what consent gates, so a revoked worker's client stops being able to write engagement rows
 * about them rather than merely stopping being read. The acting worker comes from the bearer
 * token via `@CurrentWorker` and NEVER from the body; the request schema is `.strict()`, so a
 * body carrying `worker_id` is a 400 rather than a silently ignored field.
 *
 * BOUNDS. The batch route exists because the client buffers and flushes opportunistically, which
 * is also what makes it worth bounding: 100 actions per request (the schema), and
 * `WORKER_ACTIONS_PER_HOUR` actions per worker per rolling UTC hour, counted in ACTIONS rather
 * than requests so a hundred full batches cannot walk around a per-call cap. Fail-closed on a
 * Redis outage, like every other cap in the API.
 *
 * NO EVENT OF ITS OWN: recording an action IS the event (`action.recorded`), emitted by
 * `ActionsService` — the one place that also runs the fail-closed PII guard over `context`.
 */
@Controller("workers/me/actions")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class WorkerActionsController {
  constructor(
    private readonly actions: ActionsService,
    private readonly rateLimit: SubjectRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post()
  @HttpCode(201)
  async record(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(WorkerRecordActionSchema)) dto: WorkerRecordActionDto,
    @Ctx() ctx: RequestContext,
  ) {
    await this.assertWithinCap(worker.id, 1);
    return this.actions.recordForWorker(worker.id, dto, ctx);
  }

  /**
   * The buffered flush. All-or-nothing, matching the internal batch route: every action is
   * validated before any is written, so a client never has to reason about a partial flush.
   */
  @Post("batch")
  @HttpCode(201)
  async recordBatch(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(WorkerRecordActionsBatchSchema)) dto: WorkerRecordActionsBatchDto,
    @Ctx() ctx: RequestContext,
  ) {
    // CHARGED FOR THE WHOLE BATCH, BEFORE IT IS WRITTEN. Charging 1 per call would make the
    // batch route the cheap way around the cap, which is the opposite of what it is for.
    await this.assertWithinCap(worker.id, dto.actions.length);
    return this.actions.recordBatchForWorker(worker.id, dto, ctx);
  }

  private assertWithinCap(workerId: string, cost: number): Promise<void> {
    return this.rateLimit.assertWithinHourlyCap(
      RATE_LIMIT_SCOPE,
      workerId,
      this.config.WORKER_ACTIONS_PER_HOUR,
      cost,
    );
  }
}

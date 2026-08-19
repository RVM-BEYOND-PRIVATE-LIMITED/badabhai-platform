import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { ConsentGuard } from "../auth/consent.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { SERVER_CONFIG } from "../config/config.module";
import { APP_BUILD_HEADER, sanitizeAppBuild } from "../common/app-build";
import { sanitizeScreenContext } from "../common/screen-context";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { FeedbackService } from "./feedback.service";
import { SubmitFeedbackSchema, type SubmitFeedbackDto } from "./feedback.dto";

/** Redis key namespace for the per-worker caps. Short, and never a worker's own data. */
const RATE_LIMIT_SCOPE = "worker_feedback";

/**
 * The worker's own feedback sink (#997) — `POST /workers/me/feedback`, behind the app-wide
 * Feedback button the client already ships.
 *
 * A DEDICATED CONTROLLER, NOT A METHOD ON `WorkersController`, and that is load-bearing rather
 * than tidy — the `WorkerActionsController` ruling. Nest UNIONS class-level and method-level
 * guards, so a worker route living in a class that carries `InternalServiceGuard` inherits it,
 * gets swept into `OPS_ROUTES` by `canary-coverage.test.ts`, and then fails prod-canary stage 4
 * (which sends the ops token and requires a non-401). Keeping worker-authed routes in classes
 * that can never acquire an ops guard is what makes that impossible rather than merely unlikely.
 *
 * AUTHZ. `WorkerAuthGuard` THEN `ConsentGuard`, in that order — the posture of every other
 * `/workers/me/*` route, and the order is the contract: `ConsentGuard` reads `req.worker`, which
 * `WorkerAuthGuard` attaches, so reversing them fails closed on every request. Storing a worker's
 * free text is processing of their personal data, so it must follow `consent.accepted`
 * (invariant #6) — a worker who withdrew consent stops being able to write about themselves, not
 * merely stops being read.
 *
 * THE ACTING WORKER COMES FROM THE BEARER TOKEN via `@CurrentWorker`, never from the body. The
 * request schema is `.strict()`, so a body carrying `worker_id` is a 400 rather than a silently
 * ignored IDOR attempt.
 */
@Controller("workers/me/feedback")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class WorkerFeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly rateLimit: SubjectRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * The response is `{ ok: true }` and nothing else. The shipped client ignores the body, and
   * echoing the message back would put the worker's own words on a second wire for no reason —
   * not even the row id, which is an admin-side join key and no use to the app.
   */
  @Post()
  @HttpCode(201)
  async submit(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SubmitFeedbackSchema)) dto: SubmitFeedbackDto,
    @Headers(APP_BUILD_HEADER) appBuild: string | undefined,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true }> {
    // BOTH CAPS, MINUTE FIRST. The minute bucket is the product rule — a human typing a
    // paragraph about a problem cannot honestly exceed a few in sixty seconds. The hour bucket is
    // the abuse backstop a sustained 3/min stream would otherwise walk straight past. Minute
    // first so a burst that is refused never inflates the hourly counter it was refused by; the
    // reverse ordering would let a rejected flood consume an honest worker's whole hour.
    await this.rateLimit.assertWithinMinuteCap(
      RATE_LIMIT_SCOPE,
      worker.id,
      this.config.WORKER_FEEDBACK_PER_MINUTE,
    );
    await this.rateLimit.assertWithinHourlyCap(
      RATE_LIMIT_SCOPE,
      worker.id,
      this.config.WORKER_FEEDBACK_PER_HOUR,
    );
    // SANITIZED, NEVER VALIDATING — both of them. A malformed build stamp or an unrecognisable
    // route becomes null and the submission proceeds; losing a worker's typed feedback over
    // telemetry nobody asked them for is the wrong failure direction.
    //
    // `screen` is normalized HERE, and ⚠ NO SHIPPED CLIENT SENDS IT YET — the Flutter overlay's
    // `screen` argument lives on the worker-app branch and nothing on `main` posts one, so every
    // row written today has `screen_context: null`. The server half is deliberately landed first
    // so the column, the CHECK and the spine's refusal exist before any producer does.
    //
    // Once a client does send it, normalizing again here is defence in depth and not redundancy:
    // the shipped app is not the only caller this endpoint can have, and the one that skips
    // normalization is precisely the one whose value arrives carrying a concrete entity id.
    // Doing it at the edge means no id-SHAPED value reaches the row, the event or the log —
    // there is no later layer that could forget. What it cannot do is recognise an opaque token
    // that looks like a route word; see `sanitizeScreenContext` for that residual.
    await this.feedback.submit(
      worker.id,
      dto,
      {
        appBuild: sanitizeAppBuild(appBuild),
        screenContext: sanitizeScreenContext(dto.screen),
      },
      ctx,
    );
    return { ok: true };
  }
}

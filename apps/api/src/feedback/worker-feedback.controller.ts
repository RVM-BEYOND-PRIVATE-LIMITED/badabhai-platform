import { Body, Controller, Headers, HttpCode, Inject, Logger, Post, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { WORKER_APP_SCREEN_TEMPLATES } from "@badabhai/types";

import { ConsentGuard } from "../auth/consent.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { SERVER_CONFIG } from "../config/config.module";
import { APP_BUILD_HEADER, sanitizeAppBuild } from "../common/app-build";
import { resolveScreenTemplate } from "../common/screen-context";
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
  /**
   * Only ever used for the route-table divergence WARN below. Named for the class, like every
   * other logger in this API, so the line is greppable by the surface that emitted it.
   */
  private readonly logger = new Logger(WorkerFeedbackController.name);

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
    // SANITIZED, NEVER VALIDATING — both of them. A malformed build stamp or an unrecognised
    // screen becomes null and the submission proceeds; losing a worker's typed feedback over
    // telemetry nobody asked them for is the wrong failure direction.
    //
    // `screen` is RESOLVED HERE — matched against the worker app's own route table and replaced
    // by a constant from it (`resolveScreenTemplate`), so what continues past this line cannot
    // contain a byte the caller chose. Doing it at the edge is what makes that true of the row,
    // the event AND the log line at once: there is no later layer that could forget.
    //
    // ⚠ NO SHIPPED CLIENT SENDS THE FIELD YET — the Flutter overlay's `screen` argument lives on
    // the worker-app branch and nothing on `main` posts one, so every row written today has
    // `screen_context: null`. The server half is deliberately landed first so the column, the
    // CHECK and the spine's refusal exist before any producer does.
    const screenContext = resolveScreenTemplate(dto.screen);
    // ── THE DIVERGENCE SIGNAL ────────────────────────────────────────────────────────────
    // An allowlist has exactly one long-term failure mode: the app adds a screen, this server's
    // table does not know it, and that screen reports "unknown" FOREVER while every test stays
    // green and nobody notices the hole in the telemetry.
    //
    // `screen-template-table.contract.test.ts` is the primary defence — it reads the app's
    // `router.dart` and reddens CI in the PR that adds the route. This WARN is the backstop for
    // what a repo test cannot see: a client released ahead of the server, or a caller we do not
    // build. It fires only when the caller actually sent something (an absent field is the
    // ordinary case today, not a signal), and a sustained stream of these means "re-derive the
    // table from the app".
    //
    // ⚠ NOT ONE BYTE OF `dto.screen` IS LOGGED, and that is not squeamishness — the unresolved
    // value is precisely the attacker-controlled string this whole change exists to keep out of
    // the log, so logging it "just for diagnosis" would reopen the §2 hole at the one moment the
    // value is known to be unrecognised. The count is the signal; the app's route table is where
    // the answer is.
    if (screenContext === null && typeof dto.screen === "string" && dto.screen.trim().length > 0) {
      this.logger.warn(
        `feedback screen_context matched none of the ${WORKER_APP_SCREEN_TEMPLATES.length} ` +
          `known worker-app screens — stored as null. If this is sustained, the app has a route ` +
          `WORKER_APP_SCREEN_TEMPLATES does not: re-derive it from apps/worker-app/lib/router.dart. ` +
          `(The value itself is deliberately not logged.)`,
      );
    }
    await this.feedback.submit(
      worker.id,
      dto,
      { appBuild: sanitizeAppBuild(appBuild), screenContext },
      ctx,
    );
    return { ok: true };
  }
}

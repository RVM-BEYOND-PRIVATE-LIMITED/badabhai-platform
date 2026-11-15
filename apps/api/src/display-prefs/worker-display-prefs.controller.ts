import { Body, Controller, Get, Header, HttpCode, Patch, UseGuards } from "@nestjs/common";
import { updateDisplayPrefsSchema } from "@badabhai/validators";
import type { DisplayPrefsResponse, UpdateDisplayPrefsRequest } from "@badabhai/types";

import {
  CurrentWorker,
  WorkerAuthGuard,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import { rolloutCaller } from "../feature-rollout/rollout-caller";
import { DisplayPrefsService } from "./display-prefs.service";

/**
 * The worker's theme (#2819), the `workers/me/notification-prefs` pattern: worker-self, the id from
 * `@CurrentWorker` (the bearer token) and NEVER from a path or a body, so there is no IDOR; a strict
 * zod body; `no-store`, because the reply is this worker's state.
 *
 * `WorkerAuthGuard` ONLY, NO `ConsentGuard`, deliberately: the splash and sign-in screens read the
 * theme before the worker has consented, to paint the first screen in the right theme. Nothing here
 * is profile data — a closed-set preference about the app, keyed by an opaque id.
 *
 * The rollout caller is built HERE from the guard's object as it came, because only here is it the
 * decorator's own parameter (`rollout-caller-arguments.static.test.ts`); the logic is the service's.
 */
@Controller("workers/me/display-prefs")
@UseGuards(WorkerAuthGuard)
export class WorkerDisplayPrefsController {
  constructor(private readonly prefs: DisplayPrefsService) {}

  /** The theme in force, or light / `theme_open: false` while the switch is closed. No event. */
  @Get()
  @Header("Cache-Control", "no-store")
  get(@CurrentWorker() worker: AuthenticatedWorker): Promise<DisplayPrefsResponse> {
    return this.prefs.readForWorker(worker, rolloutCaller.worker(worker));
  }

  /**
   * Save the worker's choice; a plain 404 while the switch is closed. Returns the RESULTING prefs,
   * so the app reconciles without a second GET. One `display_prefs.changed` per real change.
   */
  @Patch()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  update(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(updateDisplayPrefsSchema)) dto: UpdateDisplayPrefsRequest,
    @Ctx() ctx: RequestContext,
  ): Promise<DisplayPrefsResponse> {
    return this.prefs.writeForWorker(worker, rolloutCaller.worker(worker), dto.theme, ctx);
  }
}

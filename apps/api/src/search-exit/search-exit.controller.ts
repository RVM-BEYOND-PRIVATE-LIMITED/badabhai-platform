import { Body, Controller, Get, Header, HttpCode, Put, UseGuards } from "@nestjs/common";

import { ConsentGuard } from "../auth/consent.guard";
import {
  CurrentWorker,
  WorkerAuthGuard,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import {
  SetSearchVisibilitySchema,
  type SearchVisibilityResponse,
  type SetSearchVisibilityDto,
} from "./search-exit.dto";
import { SearchExitEnabledGuard } from "./search-exit-enabled.guard";
import { SearchExitService } from "./search-exit.service";

/**
 * "Companies can find me" (#2753 item 6), the `workers/me/work-preferences` pattern: worker-self,
 * the id from `@CurrentWorker` (the bearer token) and NEVER from a path or a body, so there is no
 * IDOR; a strict zod body; `no-store`, because the reply is this worker's state.
 *
 * GUARDS, IN ORDER: `SearchExitEnabledGuard` (off → the 404 of a route that does not exist, before
 * anything else runs), then `WorkerAuthGuard` → `ConsentGuard` like every other `workers/me/*`
 * write. A worker who withdrew consent is already out of every company's search; this switch is the
 * lighter exit for one who keeps it.
 *
 * NO Idempotency-Key, like `PUT me/work-preferences`: the PUT sets a state, a repeat is a no-op
 * that answers the same body, and an event is written only for a real change.
 *
 * 503 BEFORE MIGRATION 0169. These two routes are the WRITE path of `worker_search_exits` (the GET
 * is the screen that flips it), so with the switch on and the table missing (42P01) they answer 503
 * Service Unavailable rather than fail open: there is no honest state to show and nowhere to store
 * a leave. The READERS (company search, the unlock gate) fail open instead. See the service.
 */
@Controller("workers/me/search-visibility")
@UseGuards(SearchExitEnabledGuard, WorkerAuthGuard, ConsentGuard)
export class SearchExitController {
  constructor(private readonly searchExit: SearchExitService) {}

  /** Whether companies can find him, and since when he has been out. No event. */
  @Get()
  @Header("Cache-Control", "no-store")
  get(@CurrentWorker() worker: AuthenticatedWorker): Promise<SearchVisibilityResponse> {
    return this.searchExit.visibilityFor(worker.id);
  }

  /**
   * `{ visible: false }` takes him out of company search, `{ visible: true }` brings him back.
   * Returns the GET shape, so the app reconciles without a second read. Never touches his consent.
   */
  @Put()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  set(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetSearchVisibilitySchema)) dto: SetSearchVisibilityDto,
    @Ctx() ctx: RequestContext,
  ): Promise<SearchVisibilityResponse> {
    return this.searchExit.setVisibility(worker.id, dto.visible, "worker", ctx);
  }
}

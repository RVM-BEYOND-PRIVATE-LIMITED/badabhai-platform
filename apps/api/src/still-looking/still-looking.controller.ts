import { Body, Controller, Get, Header, HttpCode, Post, UseGuards } from "@nestjs/common";

import { ConsentGuard } from "../auth/consent.guard";
import {
  CurrentWorker,
  WorkerAuthGuard,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import {
  AnswerStillLookingSchema,
  type AnswerStillLookingDto,
  type StillLookingResponse,
} from "./still-looking.dto";
import { StillLookingEnabledGuard } from "./still-looking.flag";
import { StillLookingService } from "./still-looking.service";

/**
 * The monthly "still looking?" check (#2753 item 5), the `workers/me/search-visibility` pattern:
 * worker-self, the id from `@CurrentWorker` (the bearer token) and NEVER from a path or a body, so
 * there is no IDOR; a strict zod body; `no-store`, because the reply is this worker's state.
 *
 * GUARDS, IN ORDER: `StillLookingEnabledGuard` (off → the 404 of a route that does not exist,
 * before anything else runs), then `WorkerAuthGuard` → `ConsentGuard` like every other
 * `workers/me/*` route.
 *
 * NO Idempotency-Key, like `PUT me/work-preferences` and `PUT me/search-visibility`: a repeat of
 * the answer already stored is a no-op that answers the same body, and an event is written only
 * for an answer actually stored.
 */
@Controller("workers/me/still-looking")
@UseGuards(StillLookingEnabledGuard, WorkerAuthGuard, ConsentGuard)
export class StillLookingController {
  constructor(private readonly stillLooking: StillLookingService) {}

  /** Whether a check is due (the card), and the card's other facts. No event. */
  @Get()
  @Header("Cache-Control", "no-store")
  get(@CurrentWorker() worker: AuthenticatedWorker): Promise<StillLookingResponse> {
    return this.stillLooking.status(worker.id);
  }

  /**
   * `{ answer: "yes" | "not_now" | "hired" }` — answers the open check, or opens and answers one
   * (from Settings). Returns the GET shape, so the app reconciles without a second read.
   */
  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  answer(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(AnswerStillLookingSchema)) dto: AnswerStillLookingDto,
    @Ctx() ctx: RequestContext,
  ): Promise<StillLookingResponse> {
    return this.stillLooking.answer(worker.id, dto.answer, ctx);
  }
}

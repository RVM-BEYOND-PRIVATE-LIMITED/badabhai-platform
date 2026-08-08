import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";

import { ConsentGuard } from "../auth/consent.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ProfilingSessionService } from "./profiling-session.service";
import {
  FinalizeProfilingSchema,
  ProfilingAnswerSchema,
  ProfilingCorrectionSchema,
  ProfilingSessionParamSchema,
  StartProfilingSessionSchema,
  type FinalizeProfilingDto,
  type ProfilingAnswerDto,
  type ProfilingCorrectionDto,
  type ProfilingSessionParamDto,
  type StartProfilingSessionDto,
} from "./profiling.dto";

/**
 * The voice profiling form (worker surface).
 *
 * THE SAME SPINE AS `ChatController`, deliberately and to the letter: worker-authenticated then
 * consent-gated, in that guard order (CLAUDE.md §2 invariants 4/6), the acting worker taken from
 * the bearer token via `@CurrentWorker` and NEVER from the body, and only the session id ever
 * coming from the client — with ownership proved against the `chat_sessions` row before anything
 * is read or written. A new surface is a new front door, not a new set of locks.
 *
 * A SECOND CONTROLLER, and the reason is not that chat's was unsuitable. It is that the two need
 * different WIRE SHAPES for the same turn: chat returns chip labels to a client whose worker can
 * type instead, and this returns option keys, an `answer_type` and a `why_text` to a client whose
 * worker cannot read the screen. The turn itself is shared — every route below reaches
 * `ChatService.runTurn` — so the thing that could drift between two surfaces is exactly the thing
 * that does not exist twice.
 */
@Controller("profiling")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class ProfilingController {
  constructor(private readonly profiling: ProfilingSessionService) {}

  /**
   * Open the form. Reattaches to a live interview, or starts one.
   *
   * Body is EMPTY and strict: the worker comes from the token and the session is chosen by the
   * server, so any field here is a mistake and is rejected rather than ignored.
   */
  @Post("session")
  @HttpCode(201)
  start(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(StartProfilingSessionSchema)) _dto: StartProfilingSessionDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiling.start(worker.id, ctx);
  }

  /** One answer; blocks until the engine has chosen the next question. 409 on a stale question. */
  @Post("answer")
  @HttpCode(201)
  answer(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ProfilingAnswerSchema)) dto: ProfilingAnswerDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiling.answer(worker.id, dto, ctx);
  }

  /**
   * The review screen's rows — the worker's own answers, read back to them.
   *
   * READ-ONLY → NO EVENT, matching `ChatController.listMessages`'s reasoning: CLAUDE.md §1 binds
   * important STATE CHANGES, nothing changes here, and one event per re-entry to a review screen
   * would spam the audit spine without recording a single decision.
   */
  @Get("session/:sessionId")
  review(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param(new ZodValidationPipe(ProfilingSessionParamSchema)) params: ProfilingSessionParamDto,
  ) {
    return this.profiling.review(worker.id, params.sessionId);
  }

  /**
   * Change a SETTLED answer from the review screen — the ⟲ affordance (#700).
   *
   * The mirror image of `POST /answer`'s guard: that one 409s when the question is NOT on screen,
   * this one 409s when it still IS. A question in front of the worker belongs to the turn loop.
   *
   * 400 when the question is not in this session's pack · 409 when it is unsettled or the
   * correction cap is reached · 422 when the words parsed to no value for it.
   */
  @Post("correct")
  @HttpCode(200)
  correct(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ProfilingCorrectionSchema)) dto: ProfilingCorrectionDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiling.correct(worker.id, dto, ctx);
  }

  /**
   * Commit the reviewed session. 409 while the engine has not closed the interview — completion
   * stays engine-authoritative, and this only makes the close durable.
   */
  @Post("finalize")
  @HttpCode(200)
  finalize(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(FinalizeProfilingSchema)) dto: FinalizeProfilingDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiling.finalize(worker.id, dto.session_id, ctx);
  }
}

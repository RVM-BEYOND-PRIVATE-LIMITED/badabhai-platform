import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";

import { ConsentGuard } from "../../auth/consent.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../../auth/worker-auth.guard";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TradeFormService } from "./trade-form.service";
import { TradeFormAnswerSchema, type TradeFormAnswerDto } from "./trade-form.dto";
import {
  ChooseTierSchema,
  TradeFormViewQuery,
  type ChooseTierDto,
} from "../tiers/profiling-tier.dto";

/**
 * The trade form (worker surface).
 *
 * THE SAME SPINE AS `ChatController` AND `ProfilingController`, to the letter: worker-authenticated
 * then consent-gated, in that guard order, the acting worker taken from the bearer token via
 * `@CurrentWorker` and NEVER from the body. Note what is absent — there is no session id anywhere
 * on this surface. A form belongs to the WORKER, not to an interview: they can close the app on
 * section two and come back a week later through a different session, and `worker_pack_answer` is
 * already keyed worker-first. Accepting a session id would be accepting an identifier the server
 * does not need and would have to prove ownership of.
 */
@Controller("profiling/form")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class TradeFormController {
  constructor(private readonly form: TradeFormService) {}

  /**
   * The whole form, with every answer already given filled in.
   *
   * 404 when this worker was never handed a form — which is the ordinary case for almost every
   * worker, and is a different thing from an empty form.
   *
   * `?view=upgrade` (tiered profiling, "Add more detail") serves only the questions the worker's
   * tier asks that he has not settled yet. The default `full` is today's form.
   */
  @Get()
  schema(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Query(new ZodValidationPipe(TradeFormViewQuery)) query: TradeFormViewQuery,
  ) {
    return this.form.schema(worker.id, query.view);
  }

  /**
   * TIERED PROFILING — the tier screen's data: must the worker choose, his current tier, and the
   * minutes each tier takes for his role. `enabled: false` while the flag is off, and the client
   * then goes straight to the form. 404 when no form was handed over, like `GET` above.
   */
  @Get("tiers")
  tiers(@CurrentWorker() worker: AuthenticatedWorker, @Ctx() ctx: RequestContext) {
    return this.form.tierState(worker.id, ctx);
  }

  /**
   * TIERED PROFILING — choose the tier (first tap) or raise it ("Add more detail"). A LOWER tier
   * than the one held is a 409: tiers are only raised and answers are always kept. 404 while
   * tiers are off.
   */
  @Post("tier")
  @HttpCode(200)
  chooseTier(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ChooseTierSchema)) dto: ChooseTierDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.form.chooseTier(worker.id, dto.tier, ctx);
  }

  /**
   * Save one answer. Idempotent per question: the unique index makes a re-answer a correction
   * rather than a second row, so a client retrying on a flaky link cannot duplicate anything.
   */
  @Post("answer")
  @HttpCode(200)
  answer(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(TradeFormAnswerSchema)) dto: TradeFormAnswerDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.form.answer(worker.id, dto, ctx);
  }
}

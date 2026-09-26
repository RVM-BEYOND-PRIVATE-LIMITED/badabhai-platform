import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";

import { ConsentGuard } from "../../auth/consent.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../../auth/worker-auth.guard";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { GeneralFormService } from "./general-form.service";
import {
  GeneralFormAnswerSchema,
  type GeneralFormAnswerDto,
  type GeneralFormAnswerResponse,
  type GeneralFormSchemaResponse,
} from "./general-form.dto";

/**
 * The general form (worker surface, ADR-0045 §3.3) — the offline half of the general road, for a
 * worker whose role is outside the 21.
 *
 * THE TRADE FORM'S SPINE, to the letter: worker-authenticated then consent-gated, in that order
 * (`ConsentGuard` reads the `req.worker` that `WorkerAuthGuard` attaches), the acting worker taken
 * from the bearer token and NEVER from the body. There is no session id anywhere on this surface
 * either: the service finds the handover from the worker's own sessions, and accepting one from
 * the request would be accepting an identifier the server does not need and would have to prove
 * ownership of.
 *
 * NO MODEL BEHIND EITHER ROUTE. Everything here is deterministic worker input (R4, R6).
 */
@Controller("profiling/general-form")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class GeneralFormController {
  constructor(private readonly form: GeneralFormService) {}

  /**
   * The whole form, with the form's own two answers filled in. 404 when this worker was never
   * handed the general form — the ordinary case, and a different thing from an empty form.
   */
  @Get()
  schema(@CurrentWorker() worker: AuthenticatedWorker): Promise<GeneralFormSchemaResponse> {
    return this.form.schema(worker.id);
  }

  /**
   * Save one of the form's own two answers (`has_work_history`, `profile_brief`). The pages it
   * points at are saved through their own endpoints. 400 with a closed `error.code` for a kind
   * the question does not take or a refused brief — never quoting the text.
   */
  @Post("answer")
  @HttpCode(200)
  answer(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(GeneralFormAnswerSchema)) dto: GeneralFormAnswerDto,
    @Ctx() ctx: RequestContext,
  ): Promise<GeneralFormAnswerResponse> {
    return this.form.answer(worker.id, dto, ctx);
  }
}

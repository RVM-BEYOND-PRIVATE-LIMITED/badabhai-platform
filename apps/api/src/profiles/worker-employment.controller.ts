import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Put, UseGuards } from "@nestjs/common";

import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  SetDescriptionSourceSchema,
  SetMyEmploymentSchema,
  type SetDescriptionSourceDto,
  type SetMyEmploymentDto,
} from "./worker-employment.dto";
import { WorkerEmploymentService } from "./worker-employment.service";

/**
 * The worker's own work history (R4 Q1 — the post-interview form).
 *
 * PUT, NOT POST, because the form submits the WHOLE history every time: the worker edits a list
 * of at most four rows and sends the result. A POST-per-employer would need delete and reorder
 * routes to express the same edits, and every one of them would be a second way to violate
 * `we_worker_sort_uq`.
 *
 * The worker id comes from `@CurrentWorker`, NEVER from the body or the path — there is no route
 * shape here that could address another worker's history.
 */
@Controller("workers")
export class WorkerEmploymentController {
  constructor(private readonly employment: WorkerEmploymentService) {}

  /**
   * Replace the caller's work history. Consent-gated like every other worker write.
   *
   * The response carries a COUNT and never echoes an employer name back — the same discipline as
   * `PATCH me/name` returning `{ ok: true }`.
   */
  @Put("me/employment")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setMyEmployment(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetMyEmploymentSchema)) dto: SetMyEmploymentDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; employer_count: number }> {
    const result = await this.employment.replaceForWorker(worker.id, dto, ctx);
    return { ok: true, employer_count: result.employer_count };
  }

  /**
   * Choose which text prints as one employment's work line (#1354).
   *
   * THE MITIGATION FOR THE SECTION-8 OVERRIDE, in one route. #1350 lets the model rephrase a
   * worker's description and print it; ADR-0039 records that no test can assert the absence of
   * a plausible-but-false sentence. Only the worker knows whether one is true, so this is how
   * they say so.
   *
   * The employment id is the ONLY client-supplied identifier, and ownership is proved inside
   * the UPDATE — see `WorkerEmploymentRepository.setPolishDeclined`. The worker still comes
   * from the token.
   */
  @Put("me/employment/:employmentId/description-source")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setDescriptionSource(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("employmentId", new ParseUUIDPipe()) employmentId: string,
    @Body(new ZodValidationPipe(SetDescriptionSourceSchema)) dto: SetDescriptionSourceDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; stints_updated: number }> {
    const result = await this.employment.setDescriptionSource(worker.id, employmentId, dto, ctx);
    return { ok: true, stints_updated: result.stints_updated };
  }
}

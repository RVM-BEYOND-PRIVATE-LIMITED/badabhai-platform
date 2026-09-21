import { Body, Controller, HttpCode, Param, Put, UseGuards } from "@nestjs/common";

import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  DeclinableAttributeKeySchema,
  SetAnswerTextSourceSchema,
  type DeclinableAttributeKey,
  type SetAnswerTextSourceDto,
} from "./worker-answer-source.dto";
import { WorkerAnswerSourceService } from "./worker-answer-source.service";

/**
 * The worker's say over a model's rewrite of his own free-text answers (#1485).
 *
 * ITS OWN CONTROLLER RATHER THAN A ROUTE ON `WorkerEmploymentController`, whose whole subject is
 * "the worker's own work history". This route's subject is a profiling ANSWER, and the worker it
 * exists for is the one with no work history at all — folding it in would have put the fresher's
 * only mitigation inside the class that cannot describe him.
 *
 * THE WORKER ID COMES FROM `@CurrentWorker`, NEVER from the body or the path. The attribute key is
 * the only client-supplied value that names a row, it is validated against a closed allow-list
 * before it reaches the service, and ownership is proved inside the UPDATE — see
 * `WorkerAttributesRepository.setTextPolishDeclined`. There is no route shape here that could
 * address another worker's answer.
 */
@Controller("workers")
export class WorkerAnswerSourceController {
  constructor(private readonly answers: WorkerAnswerSourceService) {}

  /**
   * Choose which text prints for one free-text answer — his own words, or the rewrite.
   *
   * PUT, because the choice is a state the worker sets and re-sets rather than an event he appends;
   * sending `own_words` twice must mean what sending it once meant. Consent-gated like every other
   * worker write.
   *
   * The response carries a COUNT and echoes neither version of the sentence back — the same
   * discipline as `description-source` returning `stints_updated`.
   */
  @Put("me/answers/:attributeKey/text-source")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setAnswerTextSource(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("attributeKey", new ZodValidationPipe(DeclinableAttributeKeySchema))
    attributeKey: DeclinableAttributeKey,
    @Body(new ZodValidationPipe(SetAnswerTextSourceSchema)) dto: SetAnswerTextSourceDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; answers_updated: number }> {
    const result = await this.answers.setTextSource(worker.id, attributeKey, dto, ctx);
    return { ok: true, answers_updated: result.answers_updated };
  }
}

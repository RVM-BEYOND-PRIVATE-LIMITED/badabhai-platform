import { Body, Controller, Get, Header, HttpCode, Put, UseGuards } from "@nestjs/common";

import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  SetMyLanguagesSchema,
  type MyLanguagesResponse,
  type SetMyLanguagesDto,
} from "./worker-languages.dto";
import { WorkerLanguagesService } from "./worker-languages.service";

/**
 * The worker's languages — how they know each one (migration 0110, ADR-0042 D9 / Layer A (b)).
 *
 * PUT, NOT POST, because the page submits the WHOLE list every time — the same reasoning, to the
 * letter, as `PUT me/qualifications`: delete-and-reinsert is the only shape that cannot violate
 * `wl_worker_sort_uq`, and per-row routes would each be a second way to violate it.
 *
 * The worker id comes from `@CurrentWorker`, NEVER from the body or the path — there is no route
 * shape here that could address another worker's rows.
 */
@Controller("workers")
export class WorkerLanguagesController {
  constructor(private readonly languages: WorkerLanguagesService) {}

  /**
   * The caller's STORED language rows, in the PUT's own entry shapes (#1504).
   *
   * `no-store` for the same reason the qualifications prefill is: a language set plus a worker id
   * is more identifying than either alone, and a read is not a state change (no event).
   */
  @Get("me/languages")
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async getMyLanguages(@CurrentWorker() worker: AuthenticatedWorker): Promise<MyLanguagesResponse> {
    return this.languages.getForWorker(worker.id);
  }

  /**
   * Replace the caller's languages. Consent-gated like every other worker write.
   *
   * The response carries a COUNT and never echoes a language back — the same discipline as
   * `PUT me/qualifications` returning counts.
   */
  @Put("me/languages")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setMyLanguages(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetMyLanguagesSchema)) dto: SetMyLanguagesDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; language_count: number }> {
    const result = await this.languages.replaceForWorker(worker.id, dto, ctx);
    return { ok: true, language_count: result.language_count };
  }
}

import { Body, Controller, Get, HttpCode, Put, UseGuards } from "@nestjs/common";

import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { SetMyPreferencesSchema, type SetMyPreferencesDto } from "./worker-preferences.dto";
import { WorkerPreferencesService } from "./worker-preferences.service";
import { DOCUMENTS_READY, JOB_TYPES, LANGUAGES, SHIFTS } from "./worker-preferences.vocabulary";

/**
 * The finishing form's closed-set page (R6 §4).
 *
 * PUT, NOT PATCH, and the difference is the empty list. The form submits the pages the worker
 * reached; an absent key leaves the stored answer alone, an empty list clears it. A PATCH would
 * imply the second case cannot be expressed, and "none of these" is a real answer a worker must
 * be able to give and to take back.
 *
 * The worker id comes from `@CurrentWorker`, NEVER from the body or the path — there is no route
 * shape here that could address another worker's answers.
 */
@Controller("workers")
export class WorkerPreferencesController {
  constructor(private readonly preferences: WorkerPreferencesService) {}

  /**
   * The option sets, so the client renders chips from the SERVER's closed vocabulary.
   *
   * WITHOUT THIS THE CLIENT WOULD CARRY ITS OWN COPY, which is the cross-language contract
   * failure this codebase has paid for before: a Flutter list and a zod enum drift, the worker
   * taps a chip the server rejects, and nothing on either side names the cause. Serving the
   * vocabulary makes the server the only place an option exists.
   *
   * NO WORKER DATA IN THE RESPONSE — it is a static dictionary, so it is guarded for consistency
   * with the write below rather than because it discloses anything.
   */
  @Get("me/work-preferences/options")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  options(): {
    languages: Record<string, string>;
    documents_ready: Record<string, string>;
    job_type: Record<string, string>;
    shift: Record<string, string>;
  } {
    return {
      languages: LANGUAGES,
      documents_ready: DOCUMENTS_READY,
      job_type: JOB_TYPES,
      shift: SHIFTS,
    };
  }

  /**
   * Record the caller's closed-set answers. Consent-gated like every other worker write.
   *
   * The response carries COUNTS and never echoes the answers back — the same discipline as
   * `PUT me/employment` returning an employer count.
   */
  @Put("me/work-preferences")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setMyPreferences(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetMyPreferencesSchema)) dto: SetMyPreferencesDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; keys_written: number; keys_cleared: number }> {
    const result = await this.preferences.setForWorker(worker.id, dto, ctx);
    return {
      ok: true,
      keys_written: result.keys_written,
      keys_cleared: result.keys_cleared,
    };
  }
}

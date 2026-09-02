import { Body, Controller, Get, HttpCode, Put, UseGuards } from "@nestjs/common";

import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  SetMyQualificationsSchema,
  type SetMyQualificationsDto,
} from "./worker-qualifications.dto";
import { WorkerQualificationsService } from "./worker-qualifications.service";
import { EDUCATION_COUNCILS, EDUCATION_QUALIFICATIONS } from "./worker-preferences.vocabulary";

/**
 * The worker's own credentials — Zone 5's Education and Certificates rows (migration 0098).
 *
 * PUT, NOT POST, because the page submits the WHOLE list every time: the worker edits at most a
 * handful of rows and sends the result. A POST-per-certificate would need delete and reorder
 * routes to express the same edits, and every one of them would be a second way to violate
 * `wc_worker_sort_uq`. The same reasoning, to the letter, as `PUT me/employment`.
 *
 * The worker id comes from `@CurrentWorker`, NEVER from the body or the path — there is no route
 * shape here that could address another worker's credentials, and no client-supplied identifier
 * on this surface at all.
 */
@Controller("workers")
export class WorkerQualificationsController {
  constructor(private readonly qualifications: WorkerQualificationsService) {}

  /**
   * The two closed sets, so the client renders chips from the SERVER's vocabulary.
   *
   * WITHOUT THIS THE CLIENT WOULD CARRY ITS OWN COPY, which is the cross-language contract
   * failure this codebase has paid for before: a Flutter list and a zod enum drift, the worker
   * taps a chip the server rejects, and nothing on either side names the cause. The same
   * endpoint shape `me/work-preferences/options` already serves, and for the same reason.
   *
   * CERTIFICATE NAMES ARE ABSENT FROM THIS RESPONSE ON PURPOSE. They are not a closed set and
   * cannot be one — see the DTO — so the per-trade SUGGESTIONS ride the form schema, where the
   * worker's trade is already known. Serving them here would mean serving all 21 trades' lists to
   * every worker.
   *
   * NO WORKER DATA IN THE RESPONSE — it is a static dictionary, guarded for consistency with the
   * write below rather than because it discloses anything.
   */
  @Get("me/qualifications/options")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  options(): {
    education_credential: Record<string, string>;
    education_council: Record<string, string>;
  } {
    return {
      education_credential: EDUCATION_QUALIFICATIONS,
      education_council: EDUCATION_COUNCILS,
    };
  }

  /**
   * Replace the caller's credentials. Consent-gated like every other worker write.
   *
   * The response carries COUNTS and never echoes a certificate name or an institute back — the
   * same discipline as `PUT me/employment` returning an employer count.
   */
  @Put("me/qualifications")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setMyQualifications(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetMyQualificationsSchema)) dto: SetMyQualificationsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; certificate_count: number; education_count: number }> {
    const result = await this.qualifications.replaceForWorker(worker.id, dto, ctx);
    return {
      ok: true,
      certificate_count: result.certificate_count,
      education_count: result.education_count,
    };
  }
}

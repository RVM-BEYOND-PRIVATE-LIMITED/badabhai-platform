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
import { CITY_CATALOGUE, type CityOption } from "./worker-cities.catalogue";

/**
 * The preferences page's whole vocabulary, in one response.
 *
 * NAMED rather than left inline because it is a published contract with a second team. Today the
 * Flutter `WorkPrefOptionsDto` decodes the FOUR dictionaries and ignores `cities` — that is what
 * makes shipping the fifth key ahead of the client work safe — so renaming one of the four is a
 * silent empty chip row on a worker's phone, while renaming `cities` breaks nothing yet and
 * everything once #1406's UI lands.
 */
export interface WorkPreferenceOptionsResponse {
  readonly languages: Record<string, string>;
  readonly documents_ready: Record<string, string>;
  readonly job_type: Record<string, string>;
  readonly shift: Record<string, string>;
  /**
   * The preferred-city options (#1406). A LIST, not a slug→label map like its four neighbours,
   * because a city has no slug in this system — see `worker-cities.catalogue.ts`.
   */
  readonly cities: readonly CityOption[];
}

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
   *
   * `cities` RIDES THIS RESPONSE RATHER THAN A `?q=` SEARCH ROUTE (#1406). It is the same
   * argument, applied to the one field on this page that had no options to serve: the gazetteer
   * `preferred_cities` validates against is 36 values and 1.8 KB, so the client can hold it and
   * filter as the worker types — the pattern `SEARCHABLE_OPTION_THRESHOLD` already ratified for
   * every other long option list in the product. A per-keystroke route would put a network round
   * trip between a worker on 3G and his next character, to save a payload smaller than the
   * headers carrying it. This page already fetches this response on mount, so the fix costs no
   * request at all.
   *
   * ADDITIVE, so shipped builds are unaffected: the Flutter decoder reads named keys and ignores
   * the rest.
   */
  @Get("me/work-preferences/options")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  options(): WorkPreferenceOptionsResponse {
    return {
      languages: LANGUAGES,
      documents_ready: DOCUMENTS_READY,
      job_type: JOB_TYPES,
      shift: SHIFTS,
      cities: CITY_CATALOGUE,
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

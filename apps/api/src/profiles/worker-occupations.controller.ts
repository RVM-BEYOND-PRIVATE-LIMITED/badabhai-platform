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
  SetMyOccupationsSchema,
  type MyOccupationsResponse,
  type SetMyOccupationsDto,
} from "./worker-occupations.dto";
import { WorkerOccupationsService } from "./worker-occupations.service";

/**
 * The worker's SECONDARY occupations — "welding bhi karta hoon" (migration 0114, ADR-0042 D9 /
 * Layer A (f)).
 *
 * PUT, NOT POST, because the page submits the WHOLE list every time — the same reasoning, to the
 * letter, as `PUT me/languages`: delete-and-reinsert is the only shape that cannot violate
 * `wo_worker_sort_uq`, and per-row routes would each be a second way to violate it.
 *
 * The worker id comes from `@CurrentWorker`, NEVER from the body or the path — there is no route
 * shape here that could address another worker's rows.
 */
@Controller("workers")
export class WorkerOccupationsController {
  constructor(private readonly occupations: WorkerOccupationsService) {}

  /**
   * The caller's stored rows, labelled for display.
   *
   * `no-store` for the same reason the languages read is: a set of trades plus a worker id is
   * more identifying than either alone, and a read is not a state change (no event).
   */
  @Get("me/occupations")
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async getMyOccupations(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<MyOccupationsResponse> {
    return this.occupations.getForWorker(worker.id);
  }

  /**
   * Replace the caller's secondary occupations. Consent-gated like every other worker write.
   *
   * The response carries a COUNT and never echoes a role id back — the same discipline as
   * `PUT me/languages` returning counts.
   */
  @Put("me/occupations")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setMyOccupations(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetMyOccupationsSchema)) dto: SetMyOccupationsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; occupation_count: number }> {
    const result = await this.occupations.replaceForWorker(worker.id, dto, ctx);
    return { ok: true, occupation_count: result.occupation_count };
  }
}

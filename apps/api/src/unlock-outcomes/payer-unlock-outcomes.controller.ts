import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { inFlightConflict } from "../common/idempotency/in-flight-conflict";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { UnlockFollowupEnabledGuard } from "./unlock-outcomes.flag";
import { UnlockOutcomesService } from "./unlock-outcomes.service";
import {
  DueUnlocksQuerySchema,
  RecordUnlockOutcomeSchema,
  type DueUnlocksPageDto,
  type DueUnlocksQueryDto,
  type RecordUnlockOutcomeDto,
  type RecordUnlockOutcomeResponseDto,
} from "./unlock-outcomes.dto";

/**
 * #2753 item 10 — THE COMPANY FOLLOW-UP, the payer surface. Its own controller (the payer unlock
 * routes are `PayerUnlocksController`'s and are not edited), on the same conventions: the route
 * group `/payer`, `PayerAuthGuard`, the SESSION payer (XB-A: no route or body slot for a payer id),
 * and ownership by the unlock routes' chokepoint (the session's tenant key against
 * `unlocks.payer_id`, in the service).
 *
 *  - SWITCH OFF (`UNLOCK_FOLLOWUP_ENABLED`, default off): a neutral 404 from
 *    {@link UnlockFollowupEnabledGuard}, after the 401 and before anything else.
 *  - `GET /payer/unlock-outcomes/due`: the tenant's contacts due for an answer, paged like the
 *    payer lists (`limit` 1-50, default 20, opaque `cursor`). A read of the company's own unlocks,
 *    uncapped like `GET /payer/unlocks`. `no-store`: every answer changes it.
 *  - `POST /payer/unlocks/:unlockId/outcome`: HTTP only — the write cap on its own per-payer hourly
 *    bucket (`payer_unlock_outcome`, `PAYER_UNLOCK_OUTCOME_MAX_PER_HOUR`, default 600) charged
 *    BEFORE anything is read, one unit per request (a repeat or a 404 counts too: probing is not
 *    free; Redis down is the same 429); then `Idempotency-Key` (the payer write convention); then
 *    one delegation to {@link UnlockOutcomesService.recordCompanyOutcome}.
 */
@Controller("payer")
@UseGuards(PayerAuthGuard, UnlockFollowupEnabledGuard)
export class PayerUnlockOutcomesController {
  constructor(
    private readonly outcomes: UnlockOutcomesService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    private readonly idempotency: RequestIdempotency,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Get("unlock-outcomes/due")
  @Header("Cache-Control", "no-store")
  listDue(
    @Query(new ZodValidationPipe(DueUnlocksQuerySchema)) query: DueUnlocksQueryDto,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<DueUnlocksPageDto> {
    return this.outcomes.listDue(payer.id, query);
  }

  @Post("unlocks/:unlockId/outcome")
  @HttpCode(200)
  async recordOutcome(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @Body(new ZodValidationPipe(RecordUnlockOutcomeSchema)) body: RecordUnlockOutcomeDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<RecordUnlockOutcomeResponseDto> {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "payer_unlock_outcome",
      cap: this.config.PAYER_UNLOCK_OUTCOME_MAX_PER_HOUR,
    });
    return this.idempotency.runOnce({
      namespace: "payer_idem",
      // Its OWN scope: a key reused on another payer write must never be served this one's result.
      scope: "unlock_outcome",
      // The SESSION payer (XB-A) — scoping by it stops one payer replaying another's key.
      subject: payer.id,
      subjectLabel: "payer",
      logLabel: "payer",
      idempotencyKey: req.header("idempotency-key"),
      // 409, not a guessed answer: the first attempt has not decided `previous_outcome` or
      // `changed` yet. The client re-reads the due list rather than re-posting.
      inFlight: (): never => {
        throw inFlightConflict(
          "This answer is already being saved; check the contact before trying again",
        );
      },
      work: () => this.outcomes.recordCompanyOutcome(payer.id, unlockId, body.outcome, ctx),
    });
  }
}

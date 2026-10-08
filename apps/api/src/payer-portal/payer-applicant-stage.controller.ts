import { Body, Controller, HttpCode, Inject, Param, Put, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { PayerApplicantStagesEnabledGuard } from "./payer-applicant-stages.flag";
import { PayerApplicantStagesService } from "./payer-applicant-stages.service";
import {
  ApplicantStageParamsSchema,
  SetApplicantStageSchema,
  type ApplicantStageParamsDto,
  type SetApplicantStageDto,
  type SetApplicantStageResponseDto,
} from "./payer-applicant-stage.dto";

/**
 * `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` — move one applicant on a posting's
 * New / Shortlist / Passed board (owner ruling 2026-10-07: the board is saved server-side).
 *
 * WHY THIS PATH. A stage annotates a ROW of `GET /payer/reach/jobs/:jobId/applicants`, so it is a
 * sub-resource of that row: the same route group, the same `:jobId` (an agency `jobs` id or a
 * company `job_postings` id, resolved jobs-first exactly as the feed resolves it), the same
 * guard, principal and neutral 404 body. payer-web's applicants page already holds that one id
 * for either kind, so no client has to know which table a posting lives in. Two routes under
 * `/payer/job-postings/:id/…` and `/payer/agency/jobs/:id/…` would split one board in two by
 * table, and inherit those groups' ROLE gates (employer-only / agent-only writes) — whereas the
 * board, like the feed it annotates, is governed by posting OWNERSHIP alone.
 *
 * HTTP ONLY: the flag guard, the params/body validation, the per-payer write cap, then one
 * delegation to {@link PayerApplicantStagesService}, which owns ownership, membership,
 * idempotency and the event.
 *  - `payer_id` is the verified SESSION payer (XB-A); the route and body have no slot for one.
 *  - FLAG OFF (`PAYER_APPLICANT_STAGES_ENABLED`, the default): a neutral 404 from
 *    {@link PayerApplicantStagesEnabledGuard}, after the 401 and before anything else.
 *  - WRITE CAP: its own per-payer hourly bucket (`payer_applicant_stage`,
 *    `PAYER_APPLICANT_STAGE_MAX_PER_HOUR`), charged BEFORE the service so a capped payer touches
 *    no data; one unit per request, including a no-op or a 404 (probing is not free). Fails
 *    closed: Redis down is the same 429. Deliberately NOT the `payer_reach` read budget.
 */
@Controller("payer/reach")
@UseGuards(PayerAuthGuard, PayerApplicantStagesEnabledGuard)
export class PayerApplicantStageController {
  constructor(
    private readonly stages: PayerApplicantStagesService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Put("jobs/:jobId/applicants/:workerId/stage")
  @HttpCode(200)
  async setStage(
    @Param(new ZodValidationPipe(ApplicantStageParamsSchema)) params: ApplicantStageParamsDto,
    @Body(new ZodValidationPipe(SetApplicantStageSchema)) body: SetApplicantStageDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<SetApplicantStageResponseDto> {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "payer_applicant_stage",
      cap: this.config.PAYER_APPLICANT_STAGE_MAX_PER_HOUR,
    });
    return this.stages.setStage(payer.id, params.jobId, params.workerId, body.stage, ctx);
  }
}

import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { JobIdParamSchema } from "../reach/reach.dto";
import { PayerApplicantsService, type PayerApplicantListDto } from "./payer-applicants.service";
import { PayerApplicantFeedQueryPipe } from "./payer-applicant-feed-query.pipe";
import type { PayerApplicantFeedQueryDto } from "./payer-applicant-feed-query.dto";

/**
 * Payer-SELF reach view (ADR-0019 Decision C/E — closes R22 for the payer surface).
 *
 * A NEW route group under `/payer/reach/*`, gated by {@link PayerAuthGuard}, DISTINCT
 * from the UNAUTHENTICATED ops `/reach/*` views (which stay ops-only — one principal per
 * route, never conflated; R22's interim ops posture is unchanged). HTTP ONLY: it validates
 * the `:jobId`, applies the per-payer cap and delegates to {@link PayerApplicantsService},
 * which owns the source selection, the no-oracle ownership reads and the event actor:
 *  - an unknown id and another payer's id return the IDENTICAL neutral 404 (XB-A horizontal
 *    authz + F-3); `payer_id` is derived from the verified session, never the route/body, and
 *  - the legacy `jobs` list emits `feed.shown` with the payer actor.
 *
 * SCRAPE BOUND: a per-PAYER hourly cap on this read (the reach analogue of XB-G; fail
 * closed). Reach is INFORMATION-ONLY — no quota consumption, no credit debit, no payment
 * (the disclosure/billing path stays the separate `/payer/unlocks` chokepoint).
 *
 * SECURITY GATE: external untrusted boundary — a `bb-security-review` PASS (+ the reach
 * threat-model addendum) is required before merge. Mock + staging-only (ADR-0019 Phase 1).
 */
@Controller("payer/reach")
@UseGuards(PayerAuthGuard)
export class PayerReachController {
  constructor(
    private readonly applicantsService: PayerApplicantsService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * The faceless candidate list for a job or posting the caller OWNS. The `payer_id` is the
   * SESSION payer (XB-A) — never a route/body value. Bounded by the per-payer reach cap, which
   * runs BEFORE any read so a capped payer touches no data. Either list holds only workers who
   * applied (#1898); which shape comes back (agency job vs company posting) is
   * {@link PayerApplicantsService.listForOwned}'s decision.
   *
   * `?stage=` (#2737) is the saved board's filter while `PAYER_APPLICANT_STAGES_ENABLED` is on:
   * absent = `new` (the actionable feed), `all` = the full labelled board (payer-web), or one
   * named stage. While the flag is off the pipe returns `{}` and the route is exactly what it
   * was before the query existed.
   */
  @Get("jobs/:jobId/applicants")
  async applicants(
    @Param(new ZodValidationPipe(JobIdParamSchema)) params: { jobId: string },
    // `stage` only while the flag is on (the pipe picks); off, every query key is ignored.
    @Query(PayerApplicantFeedQueryPipe) query: PayerApplicantFeedQueryDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerApplicantListDto> {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "payer_reach",
      cap: this.config.PAYER_REACH_MAX_PER_HOUR,
    });
    return this.applicantsService.listForOwned(params.jobId, payer.id, ctx, query.stage);
  }
}

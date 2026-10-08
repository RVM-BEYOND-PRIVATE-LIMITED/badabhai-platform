import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { PayerApplicantInboxService } from "./payer-applicant-inbox.service";
import { PayerApplicantInboxQueryPipe } from "./payer-applicant-inbox-query.pipe";
import type {
  PayerApplicantInboxDto,
  PayerApplicantInboxQueryDto,
} from "./payer-applicant-inbox.dto";

/**
 * `GET /payer/reach/applicants` — the payer's cross-posting applicant inbox (payer-web
 * "Candidates" tab). Same `/payer/reach/*` route group, guard and principal as
 * `PayerReachController`'s per-posting list (one principal per route; the ops `/reach/*` views
 * stay separate); its own controller so that one keeps its single-dependency shape.
 *
 * HTTP ONLY: it validates the query, applies the per-payer reach cap and delegates to
 * {@link PayerApplicantInboxService}, which owns ownership, row building and events.
 *  - `payer_id` is the verified SESSION payer (XB-A); the query has no slot for one.
 *  - SCRAPE BOUND (RB-C): the SAME per-payer hourly reach bucket as the per-posting list
 *    (`payer_reach`, `PAYER_REACH_MAX_PER_HOUR`), one unit per page, checked BEFORE any read, so
 *    a capped payer touches no data and the two reads share one budget rather than doubling it.
 *    Fails closed (429) when Redis is down. Each page is at most 50 rows.
 *  - Information-only: no quota, credit or payment is touched (identity stays behind
 *    `/payer/unlocks`).
 *
 * SECURITY GATE: external untrusted boundary — like the per-posting list, a `bb-security-review`
 * PASS (reach threat-model addendum) is required before merge.
 */
@Controller("payer/reach")
@UseGuards(PayerAuthGuard)
export class PayerApplicantInboxController {
  constructor(
    private readonly inbox: PayerApplicantInboxService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Get("applicants")
  async list(
    // The base query, plus `stage` while PAYER_APPLICANT_STAGES_ENABLED is on (the pipe picks).
    @Query(PayerApplicantInboxQueryPipe) query: PayerApplicantInboxQueryDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerApplicantInboxDto> {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "payer_reach",
      cap: this.config.PAYER_REACH_MAX_PER_HOUR,
    });
    return this.inbox.list(payer.id, query, ctx);
  }
}

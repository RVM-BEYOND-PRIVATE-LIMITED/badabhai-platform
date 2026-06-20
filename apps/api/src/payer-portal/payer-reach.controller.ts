import { Controller, Get, Inject, Param, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { ReachService } from "../reach/reach.service";
import { JobIdParamSchema } from "../reach/reach.dto";

/**
 * Payer-SELF reach view (ADR-0019 Decision C/E — closes R22 for the payer surface).
 *
 * A NEW route group under `/payer/reach/*`, gated by {@link PayerAuthGuard}, DISTINCT
 * from the UNAUTHENTICATED ops `/reach/*` views (which stay ops-only — one principal per
 * route, never conflated; R22's interim ops posture is unchanged). It REUSES the
 * {@link ReachService} ranking orchestration unchanged (the deterministic RANK core, the
 * faceless worker projection, sort-never-block) — the only deltas are OWNERSHIP and the
 * event ACTOR:
 *  - the `:jobId` is resolved via the payer-scoped, NO-ORACLE ownership read (a job that
 *    does not exist OR belongs to another payer returns the IDENTICAL neutral 404 — XB-A
 *    horizontal authz + F-3); `payer_id` is derived from the verified session, never the
 *    route/body, and is consumed only in the ownership WHERE (never returned/evented), and
 *  - each `feed.shown` carries the payer actor.
 *
 * SCRAPE BOUND: a per-PAYER hourly cap on this read (the reach analogue of XB-G; fail
 * closed). Reach is INFORMATION-ONLY — no quota consumption, no credit debit, no payment
 * (the disclosure/billing path stays the separate `/unlocks` chokepoint — the canonical
 * payer-self unlock surface under PayerAuthGuard, R16 / LC-1).
 *
 * SECURITY GATE: external untrusted boundary — a `bb-security-review` PASS (+ the reach
 * threat-model addendum) is required before merge. Mock + staging-only (ADR-0019 Phase 1).
 */
@Controller("payer/reach")
@UseGuards(PayerAuthGuard)
export class PayerReachController {
  constructor(
    private readonly reach: ReachService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * The faceless ranked candidate list for a job the caller OWNS. The `payer_id` is the
   * SESSION payer (XB-A) — never a route/body value. Bounded by the per-payer reach cap.
   * Returns the SAME neutral 404 for an unknown job and another payer's job (no-oracle).
   */
  @Get("jobs/:jobId/applicants")
  async applicants(
    @Param(new ZodValidationPipe(JobIdParamSchema)) params: { jobId: string },
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "payer_reach",
      cap: this.config.PAYER_REACH_MAX_PER_HOUR,
    });
    return this.reach.applicantsForOwnedJob(params.jobId, payer.id, ctx);
  }
}

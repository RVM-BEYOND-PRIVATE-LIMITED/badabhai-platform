import { Controller, Get, Inject, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { isMatchV1Enabled, type ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { ReachService } from "../reach/reach.service";
import { JobIdParamSchema } from "../reach/reach.dto";
import { MatchCandidatesService } from "../match/match-candidates.service";
import { JobPostingsService } from "../job-postings/job-postings.service";

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
 * (the disclosure/billing path stays the separate `/payer/unlocks` chokepoint).
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
    // ADR-0036 moment ⑥ — the V1 source. Selected by MATCH_V1_ENABLED only.
    private readonly matchCandidates: MatchCandidatesService,
    private readonly jobPostings: JobPostingsService,
  ) {}

  /**
   * The faceless ranked candidate list for a job the caller OWNS. The `payer_id` is the
   * SESSION payer (XB-A) — never a route/body value. Bounded by the per-payer reach cap.
   * Returns the SAME neutral 404 for an unknown job and another payer's job (no-oracle).
   *
   * ADR-0036 moment ⑥: the ROUTE, the guard, the ownership check and the hourly cap are
   * unchanged; behind `MATCH_V1_ENABLED` the SOURCE becomes the posting's ACTUAL
   * APPLICANTS, ordered by the frozen rank snapshot, instead of the whole worker pool
   * scored by the weighted engine.
   *
   * NO `feed.shown` ON THE V1 PATH. The legacy implementation emits one impression per
   * ranked row, which made sense when the list WAS a feed of un-applied workers; a
   * company looking at people who already applied to it is not a feed impression, and
   * recording it as one would pollute the very corpus the LEARN layer reads. The read is
   * still audited — the hourly cap counts it — and the money event is the unlock.
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

    if (isMatchV1Enabled(this.config)) {
      // The SAME no-oracle ownership read the rest of the payer surface uses: an
      // unknown id and another payer's id both resolve to the identical neutral 404.
      const owned = await this.jobPostings
        .getOneForPayer(params.jobId, payer.id)
        .catch(() => undefined);
      if (!owned) throw new NotFoundException("Job not found");
      return this.matchCandidates.listForPosting(params.jobId);
    }

    return this.reach.applicantsForOwnedJob(params.jobId, payer.id, ctx);
  }
}

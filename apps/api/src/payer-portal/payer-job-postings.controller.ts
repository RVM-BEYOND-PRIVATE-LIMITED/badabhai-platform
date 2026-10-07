import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Ctx, type RequestContext } from "../common/request-context";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PayerRoles } from "../payers/payer-role.guard";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { PostingPlansService, type PostingStats } from "../posting-plans/posting-plans.service";
import { ResumeDisclosureService } from "../disclosures/resume-disclosure.service";
import type { JobPostingApi } from "../job-postings/job-postings.repository";

/** The enriched shape of one posting on the payer surface: the row + its honest
 * per-posting stats (active-plan quota/used + boost) + the résumés-downloaded count. */
type PayerJobPostingView = JobPostingApi & PostingStats & { disclosures_count: number };

/** The `payer_idem` scopes of the paid posting routes — one per route, never shared (#2103). */
type PostingPurchaseScope = "plan_purchase" | "boost_purchase" | "quota_topup_purchase";
import {
  PayerBuyPlanSchema,
  PayerBuyBoostSchema,
  PayerTopUpQuotaSchema,
  type PayerBuyPlanDto,
  type PayerBuyBoostDto,
  type PayerTopUpQuotaDto,
} from "../posting-plans/posting-plans.dto";
import {
  PayerCreateJobPostingSchema,
  ListJobPostingsQuerySchema,
  UpdateJobPostingSchema,
  type PayerCreateJobPostingDto,
  type ListJobPostingsQueryDto,
  type UpdateJobPostingDto,
} from "../job-postings/job-postings.dto";

/**
 * Payer self-serve job postings (ADR-0019 / ADR-0022 module 9) — the payer analogue
 * of the ops {@link JobPostingsController}, and a sibling of {@link
 * PayerUnlocksController}/{@link PayerReachController}/{@link PayerDisclosureController}.
 *
 * A NEW route group under `/payer/job-postings`, gated by {@link PayerAuthGuard},
 * DISTINCT from the ops `/job-postings` routes (which stay for ops-run support — one
 * principal per route, never conflated). Every action is bound to the caller's OWN
 * `payer_id` **derived from the verified session** (`req.payer.id`); the body never
 * carries `payer_id` or `created_by` (XB-A). It REUSES {@link JobPostingsService}
 * UNCHANGED in its lifecycle rules — the only deltas are OWNERSHIP (the session payer
 * is stamped on create and scopes every read/write) and the event ACTOR (payer, not
 * ops). A read/edit/close of an unknown OR another payer's posting returns the SAME
 * neutral 404 (no-oracle horizontal authz).
 *
 * Mock payments + staging-only (PAYMENTS_ENABLE_REAL=false): posting itself is free-
 * through-launch. The paid actions (buy-plan / buy-boost, B3) reuse {@link PostingPlansService}
 * UNCHANGED (mock pay, real_call honest) — they are the payer-authed, session-scoped
 * REPLACEMENT for the ops {@link import("../posting-plans/posting-plans.controller").PostingPlansController}
 * routes, closing LC-1 for the plan/boost money surface (the `payer_id` is the verified
 * session payer, never a body value — XB-A, so a payer can never buy under another payer's id
 * nor against another payer's posting). A `bb-security-review` PASS is the pre-merge gate
 * (external untrusted money boundary).
 *
 * EMPLOYER-ONLY WRITES (#1885, owner ruling 2026-10-01; GAP-FE-06): agencies post agency
 * jobs to `jobs` via `/payer/agency/jobs`, never company postings. Every WRITE route here
 * carries `@PayerRoles("employer")` — the SAME {@link PayerRoleGuard} mechanism (and the
 * same 403) the agency surface uses in reverse. The READ routes (`list`, `getOne`) carry no
 * role metadata, so an agent account that already owns `job_postings` rows keeps read-only
 * access to them (the guard is a no-op without metadata); every write on them is refused.
 */
@Controller("payer/job-postings")
@UseGuards(PayerAuthGuard, PayerRoleGuard)
export class PayerJobPostingsController {
  constructor(
    private readonly jobPostings: JobPostingsService,
    private readonly plans: PostingPlansService,
    private readonly disclosures: ResumeDisclosureService,
    private readonly idempotency: RequestIdempotency,
  ) {}

  /** Merge a posting with its honest per-posting stats + résumés-downloaded count. */
  private async enrich(
    posting: JobPostingApi,
    payerId: string,
  ): Promise<PayerJobPostingView> {
    const [stats, disclosuresCount] = await Promise.all([
      this.plans.getPostingStats(posting.id, payerId),
      this.disclosures.countDisclosuresForPosting(posting.id, payerId),
    ]);
    return { ...posting, ...stats, disclosures_count: disclosuresCount };
  }

  /** Create a posting OWNED by the caller (status=draft). payer_id from the session. */
  @Post()
  @HttpCode(201)
  @PayerRoles("employer")
  create(
    @Body(new ZodValidationPipe(PayerCreateJobPostingSchema)) dto: PayerCreateJobPostingDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.createForPayer(payer.id, dto, ctx);
  }

  /**
   * List the caller's OWN postings, newest first; optional `?status=` filter. Each
   * row is enriched with its HONEST per-posting stats (active-plan quota + used,
   * boosted flag) so the "My jobs" card shows real numbers instead of zeros — a
   * draft/plan-less posting simply carries nulls/false (never a fabricated count).
   * Stats are resolved per row against the payer's own plans (already payer-scoped),
   * so no cross-tenant data can leak.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListJobPostingsQuerySchema)) query: ListJobPostingsQueryDto,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<PayerJobPostingView[]> {
    const postings = await this.jobPostings.listForPayer(payer.id, query);
    return Promise.all(postings.map((p) => this.enrich(p, payer.id)));
  }

  /** Get one of the caller's OWN postings; no-oracle 404 for unknown OR foreign id. */
  @Get(":id")
  async getOne(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<PayerJobPostingView> {
    const posting = await this.jobPostings.getOneForPayer(id, payer.id);
    return this.enrich(posting, payer.id);
  }

  /** Edit and/or publish (draft -> open) one of the caller's OWN postings. */
  @Patch(":id")
  @HttpCode(200)
  @PayerRoles("employer")
  update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateJobPostingSchema)) dto: UpdateJobPostingDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.updateForPayer(id, payer.id, dto, ctx);
  }

  /** Close one of the caller's OWN postings (draft|open -> closed). Terminal. */
  @Post(":id/close")
  @HttpCode(200)
  @PayerRoles("employer")
  close(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.closeForPayer(id, payer.id, ctx);
  }

  /** Pause one of the caller's OWN LIVE postings (open -> paused; B1). Reversible. */
  @Post(":id/pause")
  @HttpCode(200)
  @PayerRoles("employer")
  pause(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.pauseForPayer(id, payer.id, ctx);
  }

  /** Resume one of the caller's OWN paused postings (paused -> open; B1). */
  @Post(":id/resume")
  @HttpCode(200)
  @PayerRoles("employer")
  resume(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.resumeForPayer(id, payer.id, ctx);
  }

  /**
   * Buy a paid plan for one of the caller's OWN postings (B3 / LC-1 fix; ADR-0013 Decision B).
   * OWNERSHIP is asserted FIRST via the no-oracle `getOneForPayer` — an unknown OR another
   * payer's posting returns the SAME neutral 404, so this route can never be turned into an
   * IDOR oracle nor buy a plan against a foreign posting. The `payer_id` is the SESSION payer
   * (XB-A) — never a body value. Delegates to {@link PostingPlansService.buyPlanForPayer} (the
   * mock-pay + capacity chokepoint + spine events, reused unchanged). 201 on purchase.
   *
   * IDEMPOTENT UNDER `Idempotency-Key` (#2103), configured exactly like quota top-up (#2085):
   * its own scope, keyed by the session payer, the same window, a 409 to a duplicate that lands
   * mid-flight, and the stored outcome (success or failure, with its full error body) replayed
   * to every later retry under the key. Without it a retry after a timeout bought the plan
   * twice. The header stays OPTIONAL: a client that sends none runs exactly as before.
   * Ownership is checked BEFORE the reservation, so a foreign/unknown id mints no Redis key.
   */
  @Post(":id/plan")
  @HttpCode(201)
  @PayerRoles("employer")
  async buyPlan(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerBuyPlanSchema)) dto: PayerBuyPlanDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, payer.id); // no-oracle 404 (unknown OR foreign)
    return this.runPurchaseOnce(
      "plan_purchase",
      payer,
      req,
      "This plan purchase is already being processed; check the posting before trying again",
      () => this.plans.buyPlanForPayer(id, payer.id, dto, ctx),
    );
  }

  /**
   * Buy a booster for one of the caller's OWN postings (B3 / LC-1 fix; ADR-0013 Decision B).
   * Same ownership-first no-oracle 404 + session `payer_id` (XB-A) as {@link buyPlan}. Delegates
   * to {@link PostingPlansService.buyBoostForPayer} (reused unchanged; B-R3 no overlapping boost).
   *
   * IDEMPOTENT UNDER `Idempotency-Key` (#2103) for consistency with plan / quota top-up, under
   * its OWN scope. B-R3 already refuses a second boost while one is active; the key additionally
   * makes the retry replay the FIRST purchase's 201 rather than answer it with a 409.
   */
  @Post(":id/boost")
  @HttpCode(201)
  @PayerRoles("employer")
  async buyBoost(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerBuyBoostSchema)) dto: PayerBuyBoostDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, payer.id); // no-oracle 404 (unknown OR foreign)
    return this.runPurchaseOnce(
      "boost_purchase",
      payer,
      req,
      "This boost purchase is already being processed; check the posting before trying again",
      () => this.plans.buyBoostForPayer(id, payer.id, dto, ctx),
    );
  }

  /**
   * Top up applicant-visibility quota on the caller's OWN active plan for this posting (B2 —
   * "view more → pay more"). OWNERSHIP of the posting is asserted FIRST via the no-oracle
   * `getOneForPayer` (unknown OR foreign posting → the SAME neutral 404), and the plan lookup
   * inside {@link PostingPlansService.topUpQuotaForPayer} is itself payer-scoped, so a payer
   * can only top up their own plan. The `payer_id` is the SESSION payer (XB-A) — never a body
   * value. Priced through the pricing engine + mock-paid. 201 on top-up; 409 if the posting has
   * no active plan to top up.
   *
   * IDEMPOTENT UNDER `Idempotency-Key` (#2085), the same seam and the same semantics as
   * `POST /payer/capacity` (#1148). A top-up writes no per-purchase artifact a natural key could
   * be a key OF — `quota_topup_count` is one mutable counter on the plan row that every top-up
   * adds to — so, as with capacity, only the caller can say whether two identical requests are
   * one intent or two. Without the key a retry after a timeout charged the payer twice. The
   * header stays OPTIONAL: a client that sends none runs exactly as before.
   *
   * OWNERSHIP IS CHECKED BEFORE THE RESERVATION: it is a read with no side effect, and doing it
   * first keeps an unknown or foreign posting id from minting a Redis reservation at all.
   */
  @Post(":id/quota-topup")
  @HttpCode(201)
  @PayerRoles("employer")
  async topUpQuota(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerTopUpQuotaSchema)) dto: PayerTopUpQuotaDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, payer.id); // no-oracle 404 (unknown OR foreign)
    return this.runPurchaseOnce(
      "quota_topup_purchase",
      payer,
      req,
      "This quota top-up is already being processed; check the posting before trying again",
      () => this.plans.topUpQuotaForPayer(id, payer.id, dto, ctx),
    );
  }

  /**
   * The ONE idempotency configuration every paid posting route shares (plan, boost, quota
   * top-up — #2085/#2103), so the three cannot drift. Only the scope and the in-flight wording
   * differ. Callers check ownership BEFORE calling this, so no reservation is minted for an
   * unknown or foreign posting.
   */
  private runPurchaseOnce<T>(
    // Its OWN scope per route: sharing one (or `capacity_purchase` / `credits_purchase`) would
    // let a key reused across two different purchases be served the other's stored result.
    scope: PostingPurchaseScope,
    payer: AuthenticatedPayer,
    req: Request,
    inFlightMessage: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.idempotency.runOnce({
      namespace: "payer_idem",
      scope,
      // The SESSION payer (XB-A) — scoping by it stops one payer replaying another's key.
      subject: payer.id,
      subjectLabel: "payer",
      logLabel: "payer",
      idempotencyKey: req.header("idempotency-key"),
      // 409, as on capacity: a duplicate cannot invent a plan/boost/quota it has not computed.
      // The client re-reads `GET /payer/job-postings/:id`.
      inFlight: (): never => {
        throw new ConflictException(inFlightMessage);
      },
      work,
    });
  }
}

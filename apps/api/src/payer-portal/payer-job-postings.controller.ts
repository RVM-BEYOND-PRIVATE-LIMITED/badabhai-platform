import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { PostingPlansService } from "../posting-plans/posting-plans.service";
import {
  PayerBuyPlanSchema,
  PayerBuyBoostSchema,
  type PayerBuyPlanDto,
  type PayerBuyBoostDto,
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
 */
@Controller("payer/job-postings")
@UseGuards(PayerAuthGuard)
export class PayerJobPostingsController {
  constructor(
    private readonly jobPostings: JobPostingsService,
    private readonly plans: PostingPlansService,
  ) {}

  /** Create a posting OWNED by the caller (status=draft). payer_id from the session. */
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(PayerCreateJobPostingSchema)) dto: PayerCreateJobPostingDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.createForPayer(payer.id, dto, ctx);
  }

  /** List the caller's OWN postings, newest first; optional `?status=` filter. */
  @Get()
  list(
    @Query(new ZodValidationPipe(ListJobPostingsQuerySchema)) query: ListJobPostingsQueryDto,
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    return this.jobPostings.listForPayer(payer.id, query);
  }

  /** Get one of the caller's OWN postings; no-oracle 404 for unknown OR foreign id. */
  @Get(":id")
  getOne(@Param("id", new ParseUUIDPipe()) id: string, @CurrentPayer() payer: AuthenticatedPayer) {
    return this.jobPostings.getOneForPayer(id, payer.id);
  }

  /** Edit and/or publish (draft -> open) one of the caller's OWN postings. */
  @Patch(":id")
  @HttpCode(200)
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
   */
  @Post(":id/plan")
  @HttpCode(201)
  async buyPlan(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerBuyPlanSchema)) dto: PayerBuyPlanDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, payer.id); // no-oracle 404 (unknown OR foreign)
    return this.plans.buyPlanForPayer(id, payer.id, dto, ctx);
  }

  /**
   * Buy a booster for one of the caller's OWN postings (B3 / LC-1 fix; ADR-0013 Decision B).
   * Same ownership-first no-oracle 404 + session `payer_id` (XB-A) as {@link buyPlan}. Delegates
   * to {@link PostingPlansService.buyBoostForPayer} (reused unchanged; B-R3 no overlapping boost).
   */
  @Post(":id/boost")
  @HttpCode(201)
  async buyBoost(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerBuyBoostSchema)) dto: PayerBuyBoostDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, payer.id); // no-oracle 404 (unknown OR foreign)
    return this.plans.buyBoostForPayer(id, payer.id, dto, ctx);
  }
}

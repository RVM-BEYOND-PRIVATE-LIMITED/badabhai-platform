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
import {
  PayerOrgRoleGuard,
  CurrentOrg,
  type PayerOrgContext,
} from "../payers/payer-org-role.guard";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { PostingPlansService } from "../posting-plans/posting-plans.service";
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
 * A NEW route group under `/payer/job-postings`, gated by {@link PayerAuthGuard} +
 * {@link PayerOrgRoleGuard}, DISTINCT from the ops `/job-postings` routes (which stay for
 * ops-run support — one principal per route, never conflated). OWNERSHIP is now the
 * caller's ORG (ADR-0027 B5.x Inc 1): the guard resolves the caller's org
 * (`@CurrentOrg` → `org.orgId`) server-side from the verified session, and every
 * read/write scopes by it — so ANY org member (owner + recruiter) shares the org's
 * postings. NO `@OrgRoles(...)` is declared: the guard only resolves + attaches the org,
 * it does not restrict by role. The org_id is NEVER read from a body/param (XB-A). On
 * CREATE the row stamps BOTH `org_id` (the new ownership key) AND `payer_id` = the
 * SESSION payer (rollback + the org_id_when_payer CHECK; also the `created_by` + event
 * ACTOR). It REUSES {@link JobPostingsService} UNCHANGED in its lifecycle rules — the
 * deltas are OWNERSHIP (org-scoped) and the event ACTOR (payer, not ops). A read/edit/
 * close of an unknown OR another org's posting returns the SAME neutral 404 (no-oracle
 * horizontal authz). For today's solo orgs (org == the one payer) this is
 * behavior-preserving.
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
@UseGuards(PayerAuthGuard, PayerOrgRoleGuard)
export class PayerJobPostingsController {
  constructor(
    private readonly jobPostings: JobPostingsService,
    private readonly plans: PostingPlansService,
  ) {}

  /**
   * Create a posting OWNED by the caller's ORG (status=draft). org_id + payer_id both
   * from the session (@CurrentOrg / @CurrentPayer) — never the body.
   */
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(PayerCreateJobPostingSchema)) dto: PayerCreateJobPostingDto,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.createForPayer(org.orgId, payer.id, dto, ctx);
  }

  /** List the caller's ORG's postings, newest first; optional `?status=` filter. */
  @Get()
  list(
    @Query(new ZodValidationPipe(ListJobPostingsQuerySchema)) query: ListJobPostingsQueryDto,
    @CurrentOrg() org: PayerOrgContext,
  ) {
    return this.jobPostings.listForPayer(org.orgId, query);
  }

  /** Get one of the caller's ORG's postings; no-oracle 404 for unknown OR other-org id. */
  @Get(":id")
  getOne(@Param("id", new ParseUUIDPipe()) id: string, @CurrentOrg() org: PayerOrgContext) {
    return this.jobPostings.getOneForPayer(id, org.orgId);
  }

  /** Edit and/or publish (draft -> open) one of the caller's ORG's postings. */
  @Patch(":id")
  @HttpCode(200)
  update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateJobPostingSchema)) dto: UpdateJobPostingDto,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.updateForPayer(id, org.orgId, payer.id, dto, ctx);
  }

  /** Close one of the caller's ORG's postings (draft|open -> closed). Terminal. */
  @Post(":id/close")
  @HttpCode(200)
  close(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.closeForPayer(id, org.orgId, payer.id, ctx);
  }

  /**
   * Pause one of the caller's ORG's LIVE postings (open -> paused; B1). Reversible. OWNERSHIP
   * is the session ORG (ADR-0027 B5.x Inc 3): forwards `org.orgId` (the ownership key) + the
   * session `payer.id` (the event actor) — never a body/param value.
   */
  @Post(":id/pause")
  @HttpCode(200)
  pause(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.pauseForPayer(id, org.orgId, payer.id, ctx);
  }

  /**
   * Resume one of the caller's ORG's paused postings (paused -> open; B1). OWNERSHIP is the
   * session ORG: forwards `org.orgId` + the session `payer.id` (event actor).
   */
  @Post(":id/resume")
  @HttpCode(200)
  resume(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.resumeForPayer(id, org.orgId, payer.id, ctx);
  }

  /**
   * Buy a paid plan for one of the caller's ORG's postings (B3 / LC-1 fix; ADR-0013 Decision B).
   * OWNERSHIP is asserted FIRST via the no-oracle `getOneForPayer(id, org.orgId)` — an unknown
   * OR another ORG's posting returns the SAME neutral 404, so this route can never be turned into
   * an IDOR oracle nor buy a plan against a foreign-org posting. ADR-0027 B5.x Inc 3 fixes the
   * merge-break here: this passed `payer.id` (≠ org_id) into the org-scoped `getOneForPayer`,
   * which ALWAYS 404'd — it now passes `org.orgId`. The service resolves the SAME org internally
   * from `payer.id` and keys the capacity/plan on it; `payer_id` is the SESSION payer (XB-A),
   * stamped alongside org_id. Delegates to {@link PostingPlansService.buyPlanForPayer}
   * (mock-pay + capacity chokepoint + spine events, reused unchanged). 201 on purchase.
   */
  @Post(":id/plan")
  @HttpCode(201)
  async buyPlan(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerBuyPlanSchema)) dto: PayerBuyPlanDto,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, org.orgId); // no-oracle 404 (unknown OR foreign-org)
    return this.plans.buyPlanForPayer(id, payer.id, dto, ctx);
  }

  /**
   * Buy a booster for one of the caller's ORG's postings (B3 / LC-1 fix; ADR-0013 Decision B).
   * Same ownership-first no-oracle 404 (org-scoped) + session `payer_id` (XB-A) as {@link buyPlan}
   * — also fixes the same merge-break (`getOneForPayer(id, org.orgId)`, not `payer.id`). Delegates
   * to {@link PostingPlansService.buyBoostForPayer} (reused unchanged; B-R3 no overlapping boost).
   */
  @Post(":id/boost")
  @HttpCode(201)
  async buyBoost(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerBuyBoostSchema)) dto: PayerBuyBoostDto,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, org.orgId); // no-oracle 404 (unknown OR foreign-org)
    return this.plans.buyBoostForPayer(id, payer.id, dto, ctx);
  }

  /**
   * Top up applicant-visibility quota on the caller's ORG's active plan for this posting (B2 —
   * "view more → pay more"). OWNERSHIP of the posting is asserted FIRST via the no-oracle
   * `getOneForPayer(id, org.orgId)` (unknown OR foreign-org posting → the SAME neutral 404 — the
   * same merge-break fix as {@link buyPlan}), and the plan lookup inside
   * {@link PostingPlansService.topUpQuotaForPayer} is itself org-scoped, so a member can top up
   * any of their org's plans. The `payer_id` is the SESSION payer (XB-A), stamped alongside
   * org_id. Priced through the pricing engine + mock-paid. 201 on top-up; 409 if the posting has
   * no active plan to top up.
   */
  @Post(":id/quota-topup")
  @HttpCode(201)
  async topUpQuota(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PayerTopUpQuotaSchema)) dto: PayerTopUpQuotaDto,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.jobPostings.getOneForPayer(id, org.orgId); // no-oracle 404 (unknown OR foreign-org)
    return this.plans.topUpQuotaForPayer(id, payer.id, dto, ctx);
  }
}

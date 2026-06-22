import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PayerRoles } from "../payers/payer-role.guard";
import { AgencyService } from "./agency.service";
import {
  CreateAgencyJobSchema,
  UpdateAgencyJobSchema,
  AgencyJobIdParamSchema,
  type CreateAgencyJobDto,
  type UpdateAgencyJobDto,
} from "./agency.dto";

/**
 * Agency Supply Portal — DEMAND CRUD on the faceless `jobs` entity (ADR-0022). Every route
 * is bound to exactly ONE principal class: an authenticated PAYER with role='agent'
 * (`@UseGuards(PayerAuthGuard, PayerRoleGuard)` + `@PayerRoles('agent')`). VERTICAL authz
 * (role) is enforced at the boundary by the guards; HORIZONTAL authz (tenant isolation on
 * `jobs.payer_id`) is enforced per-row in the service via the payer-scope chokepoint.
 *
 * The owning `payer_id` is ALWAYS the verified SESSION payer (XB-A) — it is never read from
 * a body or a route param. Unknown vs not-owned resolve to the IDENTICAL neutral 404
 * (no-oracle). Applicants are served by the SHIPPED `/payer/reach/jobs/:jobId/applicants`
 * (an agency job is just a `jobs` row owned by the agency) — there is no applicant route
 * here by design.
 *
 * Mock + staging-only (ADR-0022 Phase 1). Thin HTTP layer: validation via ZodValidationPipe,
 * all logic + events in {@link AgencyService}.
 */
@Controller("payer/agency/jobs")
@UseGuards(PayerAuthGuard, PayerRoleGuard)
@PayerRoles("agent")
export class AgencyJobsController {
  constructor(private readonly agency: AgencyService) {}

  /** Create an owned job (payer_id = session, status='open'). Emits job.created. */
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(CreateAgencyJobSchema)) dto: CreateAgencyJobDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.agency.createJob(payer.id, dto, ctx);
  }

  /** List the caller's OWN jobs (faceless projection: id/status/counts/bands only). */
  @Get()
  list(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.agency.listOwnJobs(payer.id);
  }

  /** Get one OWN job; neutral 404 for unknown-or-not-owned (no-oracle). */
  @Get(":jobId")
  getOne(
    @Param(new ZodValidationPipe(AgencyJobIdParamSchema)) params: { jobId: string },
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    return this.agency.getOwnJob(payer.id, params.jobId);
  }

  /** Edit an OWN job. Neutral 404 if unknown-or-not-owned. Emits job.updated. */
  @Patch(":jobId")
  @HttpCode(200)
  update(
    @Param(new ZodValidationPipe(AgencyJobIdParamSchema)) params: { jobId: string },
    @Body(new ZodValidationPipe(UpdateAgencyJobSchema)) dto: UpdateAgencyJobDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.agency.updateJob(payer.id, params.jobId, dto, ctx);
  }

  /** Close an OWN job (open -> closed, terminal). Emits job.closed. */
  @Post(":jobId/close")
  @HttpCode(200)
  close(
    @Param(new ZodValidationPipe(AgencyJobIdParamSchema)) params: { jobId: string },
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.agency.closeJob(payer.id, params.jobId, ctx);
  }

  /**
   * Pause an OWN job. Phase-1: `JobStatus` is open|closed only, so pause == close (the
   * Reach open-feed stops serving it). Emits job.updated (a serving-state toggle, distinct
   * from the terminal close event). See {@link AgencyService.pauseJob}.
   */
  @Post(":jobId/pause")
  @HttpCode(200)
  pause(
    @Param(new ZodValidationPipe(AgencyJobIdParamSchema)) params: { jobId: string },
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.agency.pauseJob(payer.id, params.jobId, ctx);
  }
}

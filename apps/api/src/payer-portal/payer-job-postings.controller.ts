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
 * Mock payments + staging-only (PAYMENTS_ENABLE_REAL=false): posting is free-through-
 * launch; this surface adds NO payment path. A `bb-security-review` PASS is the
 * pre-merge gate (external untrusted boundary).
 */
@Controller("payer/job-postings")
@UseGuards(PayerAuthGuard, PayerOrgRoleGuard)
export class PayerJobPostingsController {
  constructor(private readonly jobPostings: JobPostingsService) {}

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
}

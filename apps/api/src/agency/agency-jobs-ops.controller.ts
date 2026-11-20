import { Body, Controller, HttpCode, Param, Put, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import { AgencyService } from "./agency.service";
import {
  OpsAgencyJobParamSchema,
  OpsSetAgencyJobMatchSkillsSchema,
  type OpsAgencyJobParamDto,
  type OpsSetAgencyJobMatchSkillsDto,
} from "./agency-jobs-ops.dto";

/**
 * OPS-facing match-skill setter for agency jobs (ADR-0050 §6.1 step 2, #1983) — how ops fills
 * `jobs.match_skill_ids` on the live agency jobs before the V1 flip (ADR-0050 §6.3 step c).
 *
 * THREE GUARDS, ALL REQUIRED — the `POST /job-postings/:id/reach/widen` precedent (#1213), and for
 * the same reason: match skills decide WHICH WORKERS a job reaches, so this is not the class of
 * action the open-posture ops routes take. A caller needs the internal-service secret AND an
 * authenticated admin session AND that admin must hold `manage_agency_match_skills` (super_admin
 * only), the same capability as the Admin Portal twin `PUT /admin/agency-jobs/:jobId/match-skills`.
 * Without the role check a support or analyst session forwarded by a server-side caller could
 * change agency reach (#2902). The recorded actor (`job.updated` actor `ops`) is that admin's own
 * id from the session, never a body field (the DTO is `.strict()` and has none).
 *
 * Thin: validation by Zod, every rule (agency-only scope, closed-is-terminal, closed vocabulary +
 * cap, idempotency, the event) lives in {@link AgencyService.opsSetMatchSkills}.
 */
@Controller("ops/agency-jobs")
@UseGuards(InternalServiceGuard, AdminAuthGuard, AdminRolesGuard)
export class AgencyJobsOpsController {
  constructor(private readonly agency: AgencyService) {}

  /** Replace the job's match-skill SET (`[]` = "not chosen yet"). Idempotent; evented on change. */
  @Put(":jobId/match-skills")
  @HttpCode(200)
  @RequireAdminRole("manage_agency_match_skills")
  setMatchSkills(
    @Param(new ZodValidationPipe(OpsAgencyJobParamSchema)) params: OpsAgencyJobParamDto,
    @Body(new ZodValidationPipe(OpsSetAgencyJobMatchSkillsSchema))
    body: OpsSetAgencyJobMatchSkillsDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Ctx() ctx: RequestContext,
  ) {
    return this.agency.opsSetMatchSkills(params.jobId, body.match_skill_ids, admin.id, ctx);
  }
}

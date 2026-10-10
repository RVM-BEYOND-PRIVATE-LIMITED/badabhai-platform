import { Body, Controller, Get, HttpCode, Param, Put, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import { AgencyService } from "./agency.service";
import {
  AdminAgencyJobsQuerySchema,
  OpsAgencyJobParamSchema,
  OpsSetAgencyJobMatchSkillsSchema,
  type AdminAgencyJobsQueryDto,
  type OpsAgencyJobParamDto,
  type OpsSetAgencyJobMatchSkillsDto,
} from "./agency-jobs-ops.dto";

/** Admin Portal twin of the internal ops match-skill setter (#2144). */
@Controller("admin/agency-jobs")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AgencyJobsAdminController {
  constructor(private readonly agency: AgencyService) {}

  @Get()
  @RequireAdminRole("manage_agency_match_skills")
  list(@Query(new ZodValidationPipe(AdminAgencyJobsQuerySchema)) query: AdminAgencyJobsQueryDto) {
    return this.agency.adminListMatchSkills(query.limit);
  }

  @Get(":jobId/match-skills")
  @RequireAdminRole("manage_agency_match_skills")
  get(@Param(new ZodValidationPipe(OpsAgencyJobParamSchema)) params: OpsAgencyJobParamDto) {
    return this.agency.adminGetMatchSkills(params.jobId);
  }

  @Put(":jobId/match-skills")
  @HttpCode(200)
  @RequireAdminRole("manage_agency_match_skills")
  set(
    @Param(new ZodValidationPipe(OpsAgencyJobParamSchema)) params: OpsAgencyJobParamDto,
    @Body(new ZodValidationPipe(OpsSetAgencyJobMatchSkillsSchema))
    body: OpsSetAgencyJobMatchSkillsDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Ctx() ctx: RequestContext,
  ) {
    return this.agency.opsSetMatchSkills(params.jobId, body.match_skill_ids, admin.id, ctx);
  }
}

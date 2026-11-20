import { Body, Controller, Get, HttpCode, Param, Put, Post, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import { AdminJobAudienceEnabledGuard } from "../job-postings/admin-job-audience.flag";
import {
  AudienceBulkSchema,
  AudienceListQuerySchema,
  AudienceSetSchema,
  type AudienceBulkDto,
  type AudienceListQueryDto,
  type AudienceSetDto,
} from "./admin-posting-audience.dto";
import { AdminPostingTargetParamsSchema, type AdminPostingTargetParamsDto } from "./admin-postings.dto";
import { AdminPostingAudienceService } from "./admin-posting-audience.service";

/**
 * #2956 — WHERE A POSTING SHOWS, decided by an admin (owner direction of 19 Nov 2026, #2959), under
 * the #2566 capability (`manage_postings`: super_admin, ops_admin), the people who already hide,
 * verify and open postings.
 *
 *   GET  admin/postings/audience?filter=to_decide|campus|both|badabhai|changed   the list
 *   POST admin/postings/audience                                                bulk: many postings, one choice
 *   PUT  admin/postings/:id/audience                                            one posting
 *
 * Behind `ADMIN_JOB_AUDIENCE_ENABLED` (a neutral 404 for every role while off, before any pipe or
 * query). Every write requires a written reason and records it in `audit_logs`. The actor is
 * ALWAYS the session admin; no body carries an actor id.
 */
@Controller("admin/postings")
@UseGuards(AdminAuthGuard, AdminJobAudienceEnabledGuard, AdminRolesGuard)
export class AdminPostingAudienceController {
  constructor(private readonly service: AdminPostingAudienceService) {}

  @Get("audience")
  @RequireAdminRole("manage_postings")
  list(
    @Query(new ZodValidationPipe(AudienceListQuerySchema)) query: AudienceListQueryDto,
  ) {
    return this.service.list(query);
  }

  @Post("audience")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  setMany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AudienceBulkSchema)) dto: AudienceBulkDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.setMany(admin.id, dto, ctx);
  }

  @Put(":id/audience")
  @RequireAdminRole("manage_postings")
  set(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AudienceSetSchema)) dto: AudienceSetDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.set(admin.id, params.id, dto, ctx);
  }
}

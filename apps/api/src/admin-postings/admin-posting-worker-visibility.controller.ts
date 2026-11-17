import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import {
  WorkerVisibilityBulkSchema,
  WorkerVisibilityListQuerySchema,
  WorkerVisibilitySetSchema,
  type WorkerVisibilityBulkDto,
  type WorkerVisibilityListQueryDto,
  type WorkerVisibilitySetDto,
} from "./admin-posting-worker-visibility.dto";
import { AdminPostingTargetParamsSchema, type AdminPostingTargetParamsDto } from "./admin-postings.dto";
import { AdminPostingWorkerVisibilityService } from "./admin-posting-worker-visibility.service";

/**
 * #2891 — BadaBhai worker visibility of Campus-origin postings, under the #2566 capability
 * (`manage_postings`: super_admin, ops_admin), the people who already hide and verify postings.
 *
 *   GET  admin/postings/worker-visibility?filter=waiting|off|on   the list (default `waiting`)
 *   POST admin/postings/worker-visibility                         bulk: many postings, one state
 *   POST admin/postings/:id/worker-visibility                     one posting
 *
 * Every write requires a written reason and records it in `audit_logs`. The actor is ALWAYS the
 * session admin; no body carries an actor id.
 */
@Controller("admin/postings")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminPostingWorkerVisibilityController {
  constructor(private readonly service: AdminPostingWorkerVisibilityService) {}

  @Get("worker-visibility")
  @RequireAdminRole("manage_postings")
  list(
    @Query(new ZodValidationPipe(WorkerVisibilityListQuerySchema))
    query: WorkerVisibilityListQueryDto,
  ) {
    return this.service.list(query);
  }

  @Post("worker-visibility")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  setMany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(WorkerVisibilityBulkSchema)) dto: WorkerVisibilityBulkDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.setMany(admin.id, dto, ctx);
  }

  @Post(":id/worker-visibility")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  set(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(WorkerVisibilitySetSchema)) dto: WorkerVisibilitySetDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.set(admin.id, params.id, dto, ctx);
  }
}

import { Body, Controller, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import {
  AdminPostingEditSchema,
  AdminPostingReasonSchema,
  AdminPostingTargetParamsSchema,
  AdminPostingVerificationReasonSchema,
  type AdminPostingEditDto,
  type AdminPostingReasonDto,
  type AdminPostingTargetParamsDto,
  type AdminPostingVerificationReasonDto,
} from "./admin-postings.dto";
import { AdminPostingsService } from "./admin-postings.service";

/**
 * #2566 — ADMIN control of company postings and agency jobs.
 *
 * ONE route family, ONE capability (`manage_postings`): edit, pause, resume, close, hide,
 * unhide, verify and reject. A company posting (`job_postings`) and an agency job (`jobs`)
 * are addressed by the same `:id`; the service resolves it, and a twin resolves to its
 * source agency job (ADR-0050 — the sync is the twin's only writer). Every route requires a
 * written reason and commits its SoR write, `audit_logs` row, `admin.action_performed` and
 * domain event in one transaction.
 *
 * The actor is ALWAYS the session admin; no body carries an actor or target id.
 */
@Controller("admin/postings")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminPostingsController {
  constructor(private readonly service: AdminPostingsService) {}

  @Patch(":id/edit")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  edit(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingEditSchema)) dto: AdminPostingEditDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.edit(admin.id, params.id, dto, ctx);
  }

  @Post(":id/pause")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  pause(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingReasonSchema)) dto: AdminPostingReasonDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.pause(admin.id, params.id, dto, ctx);
  }

  @Post(":id/resume")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  resume(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingReasonSchema)) dto: AdminPostingReasonDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.resume(admin.id, params.id, dto, ctx);
  }

  @Post(":id/close")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  close(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingReasonSchema)) dto: AdminPostingReasonDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.close(admin.id, params.id, dto, ctx);
  }

  @Post(":id/hide")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  hide(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingReasonSchema)) dto: AdminPostingReasonDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.hide(admin.id, params.id, dto, ctx);
  }

  @Post(":id/unhide")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  unhide(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingReasonSchema)) dto: AdminPostingReasonDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.unhide(admin.id, params.id, dto, ctx);
  }

  @Post(":id/verify")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  verify(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingVerificationReasonSchema))
    dto: AdminPostingVerificationReasonDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.verify(admin.id, params.id, dto, ctx);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  reject(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(AdminPostingVerificationReasonSchema))
    dto: AdminPostingVerificationReasonDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.reject(admin.id, params.id, dto, ctx);
  }
}

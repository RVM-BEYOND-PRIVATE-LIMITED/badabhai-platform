import { Body, Controller, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminActionsService } from "./admin-actions.service";
import {
  AdminChangeRoleSchema,
  AdminFlagWorkerSchema,
  AdminGrantCreditsSchema,
  AdminInviteSchema,
  AdminTargetParamsSchema,
  type AdminChangeRoleDto,
  type AdminFlagWorkerDto,
  type AdminGrantCreditsDto,
  type AdminInviteDto,
  type AdminTargetParamsDto,
} from "./admin-actions.dto";

/**
 * Governed admin entity actions (ADR-0025 ADMIN-3a, Decision 3/5/6) — the WRITE half of the
 * Admin Ops Portal. Every route mutates ONE system-of-record table and emits EXACTLY ONE
 * value-free `admin.action_performed` (the spine stays read-only — emit only, never
 * UPDATE/DELETE on `events`).
 *
 * RBAC (deny-by-default, ONE principal + ONE role per route):
 *   - EVERY route is behind {@link AdminAuthGuard} (authn) + {@link AdminRolesGuard} (authz).
 *   - Each declares EXACTLY ONE {@link RequireAdminRole} capability — the entity-action caps are
 *     super_admin + ops_admin (suspend_payer/grant_credits/force_close_posting/flag_worker);
 *     the `manage_admins` routes are super_admin ONLY (ops_admin → 403). support/analyst are
 *     denied every 3a write.
 *
 * NON-SPOOFABLE actor/target: the actor is ALWAYS `@CurrentAdmin().id` (the session admin —
 * never a body field); the target id is the VALIDATED path param (uuid). No body here carries
 * an actor or target id.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminActionsController {
  constructor(private readonly service: AdminActionsService) {}

  // ----- payers -------------------------------------------------------------

  @Post("payers/:id/suspend")
  @HttpCode(200)
  @RequireAdminRole("suspend_payer")
  suspendPayer(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.suspendPayer(admin.id, params.id, ctx);
  }

  @Post("payers/:id/reinstate")
  @HttpCode(200)
  @RequireAdminRole("suspend_payer")
  reinstatePayer(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.reinstatePayer(admin.id, params.id, ctx);
  }

  @Post("payers/:id/credits")
  @HttpCode(200)
  @RequireAdminRole("grant_credits")
  grantCredits(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Body(new ZodValidationPipe(AdminGrantCreditsSchema)) dto: AdminGrantCreditsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.grantCredits(admin.id, params.id, dto, ctx);
  }

  // ----- job postings -------------------------------------------------------

  @Post("job-postings/:id/close")
  @HttpCode(200)
  @RequireAdminRole("force_close_posting")
  forceClosePosting(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.forceClosePosting(admin.id, params.id, ctx);
  }

  // ----- workers (flag / unflag) --------------------------------------------

  @Post("workers/:id/flag")
  @HttpCode(200)
  @RequireAdminRole("flag_worker")
  flagWorker(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Body(new ZodValidationPipe(AdminFlagWorkerSchema)) dto: AdminFlagWorkerDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.flagWorker(admin.id, params.id, dto, ctx);
  }

  @Post("workers/:id/unflag")
  @HttpCode(200)
  @RequireAdminRole("flag_worker")
  unflagWorker(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.unflagWorker(admin.id, params.id, ctx);
  }

  // ----- admin management (manage_admins — super_admin only) -----------------

  @Post("admins")
  @HttpCode(201)
  @RequireAdminRole("manage_admins")
  inviteAdmin(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminInviteSchema)) dto: AdminInviteDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.inviteAdmin(admin.id, dto, ctx);
  }

  @Patch("admins/:id/role")
  @HttpCode(200)
  @RequireAdminRole("manage_admins")
  changeAdminRole(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Body(new ZodValidationPipe(AdminChangeRoleSchema)) dto: AdminChangeRoleDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.changeAdminRole(admin.id, params.id, dto, ctx);
  }

  @Post("admins/:id/suspend")
  @HttpCode(200)
  @RequireAdminRole("manage_admins")
  suspendAdmin(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.suspendAdmin(admin.id, params.id, ctx);
  }
}

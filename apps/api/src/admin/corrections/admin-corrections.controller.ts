import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import {
  AdminCorrectionCreateSchema,
  AdminCorrectionFactParamsSchema,
  AdminCorrectionParamsSchema,
  AdminCorrectionRevertSchema,
  type AdminCorrectionCreateDto,
  type AdminCorrectionFactParamsDto,
  type AdminCorrectionHistoryItem,
  type AdminCorrectionParamsDto,
  type AdminCorrectionResult,
  type AdminCorrectionRevertDto,
} from "./admin-corrections.dto";
import { AdminCorrectionService } from "./admin-corrections.service";

/**
 * #2561 — ADMIN corrections of candidate fields (ADR-0062 §3.1/§3.8).
 *
 *   POST /admin/candidates/:id/corrections                  create / re-correct
 *   POST /admin/candidates/:id/corrections/:factKey/revert  revert to the previous value
 *   GET  /admin/candidates/:id/corrections                  the reason history
 *
 * All three are `edit_candidates` (super_admin, ops_admin, support) and set
 * `Cache-Control: no-store`: the history carries admin-authored reasons, and a correction
 * response is per-worker state. The actor is always the session admin; the target is the
 * validated path id, never a body value.
 */
@Controller("admin/candidates/:id/corrections")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCorrectionsController {
  constructor(private readonly service: AdminCorrectionService) {}

  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("edit_candidates")
  correct(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCorrectionParamsSchema)) params: AdminCorrectionParamsDto,
    @Body(new ZodValidationPipe(AdminCorrectionCreateSchema)) dto: AdminCorrectionCreateDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCorrectionResult> {
    return this.service.correct(admin, params.id, dto, ctx);
  }

  @Post(":factKey/revert")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("edit_candidates")
  revert(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCorrectionFactParamsSchema))
    params: AdminCorrectionFactParamsDto,
    @Body(new ZodValidationPipe(AdminCorrectionRevertSchema)) dto: AdminCorrectionRevertDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCorrectionResult> {
    return this.service.revert(admin, params.id, params.factKey, dto, ctx);
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("edit_candidates")
  history(
    @Param(new ZodValidationPipe(AdminCorrectionParamsSchema)) params: AdminCorrectionParamsDto,
  ): Promise<{ worker_id: string; items: AdminCorrectionHistoryItem[] }> {
    return this.service.history(params.id);
  }
}

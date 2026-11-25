import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import {
  NarrowQueueQuerySchema,
  NarrowTradeSchema,
  type NarrowQueueQueryDto,
  type NarrowTradeDto,
} from "./admin-campus-narrow.dto";
import { AdminPostingTargetParamsSchema, type AdminPostingTargetParamsDto } from "./admin-postings.dto";
import { AdminCampusNarrowService } from "./admin-campus-narrow.service";

/**
 * #3033 — the Campus narrow queue, under the #2566 capability (`manage_postings`).
 *
 *   GET  admin/postings/campus-narrow-queue   open Campus jobs on the general CNC skill only
 *   POST admin/postings/:id/narrow-trade      narrow one to a machine trade
 *
 * The queue is read-only (job id, company, the Campus role text, posted date). The write runs
 * the same `normalizeSelection` as a company edit and records who narrowed it and from what
 * in `audit_logs` plus the existing `posting_edited` admin-action event. No feature switch:
 * like the #2891 visibility control, this narrows what already exists.
 */
@Controller("admin/postings")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCampusNarrowController {
  constructor(private readonly service: AdminCampusNarrowService) {}

  @Get("campus-narrow-queue")
  @RequireAdminRole("manage_postings")
  queue(@Query(new ZodValidationPipe(NarrowQueueQuerySchema)) query: NarrowQueueQueryDto) {
    return this.service.list(query);
  }

  @Post(":id/narrow-trade")
  @HttpCode(200)
  @RequireAdminRole("manage_postings")
  narrow(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPostingTargetParamsSchema))
    params: AdminPostingTargetParamsDto,
    @Body(new ZodValidationPipe(NarrowTradeSchema)) dto: NarrowTradeDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.narrow(admin.id, params.id, dto, ctx);
  }
}

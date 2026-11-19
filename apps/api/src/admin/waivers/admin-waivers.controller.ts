import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { toWaiver } from "../../campus-link/campus-waivers.controller";
import {
  RvmWaiversService,
  WaiverCompanyNotFoundError,
  WaiverEndDateDiffersError,
  WaiverEndDateInvalidError,
  WaiverEndDatesOffError,
  WaiverPostingNotFoundError,
} from "../../rvm-waivers/rvm-waivers.service";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import {
  AdminListWaiversQuerySchema,
  AdminSetWaiverSchema,
  type AdminListWaiversQuery,
  type AdminSetWaiverDto,
  type AdminSetWaiverResponse,
  type AdminWaiverPageResponse,
} from "./admin-waivers.dto";

/**
 * #2750 items 5 and 12 — the placement team's waivers in the admin console.
 *
 *   GET /admin/waivers   waivers, newest first: active only unless `include_cleared=true`, one
 *                        company's when `company_id` is given, each with who set it (name
 *                        decrypted), why, and the opens it paid for.
 *   PUT /admin/waivers   set or clear the waiver of one company or one job, with a written reason.
 *
 * Both are behind {@link AdminAuthGuard} + {@link AdminRolesGuard} with ONE capability,
 * `manage_waivers` (super_admin only). Both answer 404 while the `credit_rules` switch is off
 * everywhere, and 503 with it on and the waiver tables missing. An unknown or barred company, or a
 * job that is not that company's, is a 404. The actor is always `@CurrentAdmin().id`; the change,
 * its `audit_logs` row and its `payer.rvm_waiver_*` event commit together.
 *
 * #2778 — with RVM_WAIVER_END_DATES_ENABLED on, a set may carry `ends_on` (400 while off or in the
 * past; 409 when the waiver in force has another end date). Every waiver shows `ends_on` / `ended`.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminWaiversController {
  constructor(private readonly waivers: RvmWaiversService) {}

  @Get("waivers")
  @RequireAdminRole("manage_waivers")
  async listWaivers(
    @Query(new ZodValidationPipe(AdminListWaiversQuerySchema)) query: AdminListWaiversQuery,
  ): Promise<AdminWaiverPageResponse> {
    const page = await this.waivers.list({
      ...(query.company_id ? { companyId: query.company_id } : {}),
      includeCleared: query.include_cleared === "true",
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    return { waivers: page.waivers.map(toWaiver), next_cursor: page.nextCursor };
  }

  @Put("waivers")
  @HttpCode(200)
  @RequireAdminRole("manage_waivers")
  async setWaiver(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminSetWaiverSchema)) dto: AdminSetWaiverDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminSetWaiverResponse> {
    try {
      const result = await this.waivers.set(
        {
          scope: dto.scope,
          companyId: dto.company_id,
          postingId: dto.posting_id ?? null,
          active: dto.active,
          reason: dto.reason_text,
          actor: { kind: "admin", adminId: admin.id },
          endsOn: dto.ends_on ?? null,
        },
        ctx,
      );
      return {
        active: result.active,
        changed: result.changed,
        waiver: result.waiver ? toWaiver(result.waiver) : null,
      };
    } catch (err) {
      if (err instanceof WaiverCompanyNotFoundError || err instanceof WaiverPostingNotFoundError) {
        throw new NotFoundException();
      }
      // #2778 — an end date that cannot be taken (switched off, in the past) is a 400; a waiver in
      // force with another end date is a 409 (clear it, then set it again).
      if (err instanceof WaiverEndDatesOffError || err instanceof WaiverEndDateInvalidError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof WaiverEndDateDiffersError) {
        throw new ConflictException("the waiver in force has another end date; clear it first");
      }
      throw err;
    }
  }
}

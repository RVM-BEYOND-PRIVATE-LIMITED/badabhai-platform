import { Body, Controller, Get, HttpCode, Put, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TradeReleaseService } from "../../trade-release/trade-release.service";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import {
  AdminSetTradeReleaseSchema,
  type AdminSetTradeReleaseDto,
  type AdminSetTradeReleaseResponse,
  type AdminTradeReleaseListResponse,
} from "./admin-trade-release.dto";

/**
 * #3002 — the per-trade release switch in the admin console (#3023 builds the screen).
 *
 *   GET /admin/trade-release   every trade kind, with its flags (a kind with no row reads as off)
 *   PUT /admin/trade-release   set one trade's flags, emitting `trade_release.changed`
 *
 * Both are behind {@link AdminAuthGuard} + {@link AdminRolesGuard} with ONE capability,
 * `manage_trade_release` (super_admin only — a trade policy list, like `manage_campus_trades`).
 * The actor is always `@CurrentAdmin().id`. The write answers 503 while the `trade_release`
 * table is missing; the read does the same.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminTradeReleaseController {
  constructor(private readonly releases: TradeReleaseService) {}

  @Get("trade-release")
  @RequireAdminRole("manage_trade_release")
  async listReleases(): Promise<AdminTradeReleaseListResponse> {
    return this.releases.getAll();
  }

  @Put("trade-release")
  @HttpCode(200)
  @RequireAdminRole("manage_trade_release")
  async setRelease(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminSetTradeReleaseSchema)) dto: AdminSetTradeReleaseDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminSetTradeReleaseResponse> {
    const result = await this.releases.set(
      admin.id,
      {
        roleKind: dto.role_kind,
        postingEnabled: dto.posting_enabled,
        formEnabled: dto.form_enabled,
      },
      ctx,
    );
    return { changed: result.changed, release: result.release };
  }
}

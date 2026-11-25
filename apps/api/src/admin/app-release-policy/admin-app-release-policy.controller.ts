import { Body, Controller, Get, HttpCode, Put, UseGuards } from "@nestjs/common";

import { AdminSetAppReleasePolicySchema } from "../../app-version/app-version.dto";
import { AppVersionService } from "../../app-version/app-version.service";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import type {
  AdminAppReleasePolicyListResponse,
  AdminSetAppReleasePolicyBody,
  AdminSetAppReleasePolicyResponse,
} from "./admin-app-release-policy.dto";

/**
 * #3048 — the minimum supported app build in the admin console.
 *
 *   GET /admin/app-release-policy   all four app × platform rows, with who changed each and when
 *   PUT /admin/app-release-policy   set one row, emitting `app_version.policy_changed`
 *
 * Both are behind {@link AdminAuthGuard} + {@link AdminRolesGuard} with ONE capability,
 * `manage_app_release_policy` (super_admin only: one raised number stops every older install from
 * writing). The actor is always `@CurrentAdmin().id`. Both answer 503 while the
 * `app_release_policy` table is missing.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminAppReleasePolicyController {
  constructor(private readonly policy: AppVersionService) {}

  @Get("app-release-policy")
  @RequireAdminRole("manage_app_release_policy")
  async listPolicies(): Promise<AdminAppReleasePolicyListResponse> {
    return this.policy.getAll();
  }

  @Put("app-release-policy")
  @HttpCode(200)
  @RequireAdminRole("manage_app_release_policy")
  async setPolicy(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminSetAppReleasePolicySchema)) dto: AdminSetAppReleasePolicyBody,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminSetAppReleasePolicyResponse> {
    const result = await this.policy.set(
      admin.id,
      dto.app,
      dto.platform,
      {
        minSupportedBuild: dto.min_supported_build,
        latestBuild: dto.latest_build,
        storeUrl: dto.store_url,
        messageKey: dto.message_key,
      },
      ctx,
    );
    return { changed: result.changed, policy: result.policy };
  }
}

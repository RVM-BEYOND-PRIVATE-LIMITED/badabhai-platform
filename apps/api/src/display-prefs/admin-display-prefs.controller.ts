import { Body, Controller, Get, Header, HttpCode, Patch, UseGuards } from "@nestjs/common";
import { updateDisplayPrefsSchema } from "@badabhai/validators";
import type { DisplayPrefsResponse, UpdateDisplayPrefsRequest } from "@badabhai/types";

import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import { rolloutCaller } from "../feature-rollout/rollout-caller";
import { DisplayPrefsService } from "./display-prefs.service";

/**
 * An admin's theme (#2819), `admin/me/display-prefs` beside `GET admin/me`. `AdminAuthGuard` ONLY,
 * like `admin/me`: every admin role may set its own theme, so no `AdminRolesGuard` capability. The
 * id is the guard's `admin.id`, never a path or a body. Strict zod body, `no-store`.
 *
 * The rollout caller is built HERE from the guard's object as it came, because only here is it the
 * decorator's own parameter (`rollout-caller-arguments.static.test.ts`); the logic is the service's.
 */
@Controller("admin/me/display-prefs")
@UseGuards(AdminAuthGuard)
export class AdminDisplayPrefsController {
  constructor(private readonly prefs: DisplayPrefsService) {}

  /** The theme in force, or light / `theme_open: false` while the switch is closed. No event. */
  @Get()
  @Header("Cache-Control", "no-store")
  get(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<DisplayPrefsResponse> {
    return this.prefs.readForAdmin(admin, rolloutCaller.admin(admin));
  }

  /** Save the admin's choice; a plain 404 while the switch is closed. Returns the RESULTING prefs. */
  @Patch()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  update(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(updateDisplayPrefsSchema)) dto: UpdateDisplayPrefsRequest,
    @Ctx() ctx: RequestContext,
  ): Promise<DisplayPrefsResponse> {
    return this.prefs.writeForAdmin(admin, rolloutCaller.admin(admin), dto.theme, ctx);
  }
}

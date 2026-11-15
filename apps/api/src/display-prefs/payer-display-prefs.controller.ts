import { Body, Controller, Get, Header, HttpCode, Patch, UseGuards } from "@nestjs/common";
import { updateDisplayPrefsSchema } from "@badabhai/validators";
import type { DisplayPrefsResponse, UpdateDisplayPrefsRequest } from "@badabhai/types";

import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import { CurrentPayer, PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { DisplayPrefsService } from "./display-prefs.service";

/**
 * A company or agency login's theme (#2819), on its own `payer/me/display-prefs` controller so it
 * cannot collide with `PayerAccountController`'s `GET`/`PATCH payer/me` (a distinct path, and no
 * route of either class can match the other's).
 *
 * `PayerAuthGuard` ONLY: both roles (`employer` and `agent`), so no `PayerRoleGuard`, and no
 * `PayerOrgRoleGuard` (a tenancy refusal must close the theme, never 403 it). The id is the
 * guard's `payer.id` — the LOGIN, a personal preference, so two teammates keep two themes — never a
 * path or a body. Strict zod body, `no-store`. The company's pilot place (its tenant key) is
 * resolved by the service.
 */
@Controller("payer/me/display-prefs")
@UseGuards(PayerAuthGuard)
export class PayerDisplayPrefsController {
  constructor(private readonly prefs: DisplayPrefsService) {}

  /** The theme in force, or light / `theme_open: false` while the switch is closed. No event. */
  @Get()
  @Header("Cache-Control", "no-store")
  get(@CurrentPayer() payer: AuthenticatedPayer): Promise<DisplayPrefsResponse> {
    return this.prefs.readForPayer(payer);
  }

  /** Save the login's choice; a plain 404 while the switch is closed. Returns the RESULTING prefs. */
  @Patch()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  update(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Body(new ZodValidationPipe(updateDisplayPrefsSchema)) dto: UpdateDisplayPrefsRequest,
    @Ctx() ctx: RequestContext,
  ): Promise<DisplayPrefsResponse> {
    return this.prefs.writeForPayer(payer, dto.theme, ctx);
  }
}

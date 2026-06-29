import { Body, Controller, Get, Header, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminKillSwitchService } from "./admin-kill-switch.service";
import {
  AdminKillSwitchPauseRequestSchema,
  type AdminKillSwitchPauseRequestDto,
  type AdminKillSwitchPauseRequestResponse,
  type KillSwitchStatusResponse,
} from "./admin-kill-switch.dto";

/**
 * The ADMIN-3c kill-switch surface (ADR-0025 OQ-6) — DISPLAY + safe-direction PAUSE INTENT only.
 *
 * OQ-6 HARD LINE (§2 #5 / §7): the portal DISPLAYS the live provider/operational switch state and
 * records a safe-direction PAUSE INTENT — it NEVER enables a real provider. There is no enable /
 * resume / toggle route here BY CONSTRUCTION (the safe-direction guarantee is structural — the
 * only two routes are a read and a pause-intent record); enabling stays env/deploy-gated.
 *
 * RBAC (deny-by-default, break-glass): {@link AdminAuthGuard} (authn) + {@link AdminRolesGuard}
 * (authz) + EXACTLY ONE {@link RequireAdminRole}("toggle_kill_switch") per route. Per the
 * capability matrix `toggle_kill_switch` is `super_admin` ONLY — ops_admin/support/analyst → 403.
 *
 * NON-SPOOFABLE actor: the actor is ALWAYS `@CurrentAdmin().id` (the session admin), never a body
 * field. The pause-request body is `.strict()` with CLOSED enums — no value/secret can ride in.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminKillSwitchController {
  constructor(private readonly service: AdminKillSwitchService) {}

  /**
   * GET /admin/kill-switch/status — read-only DISPLAY of the live switch state (OQ-6 a). PII-free
   * (enums/labels/booleans + a PII-free reason). `Cache-Control: no-store` keeps the operational
   * posture out of any shared cache (defense-in-depth). Emits nothing (a read is observability).
   */
  @Get("kill-switch/status")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("toggle_kill_switch")
  status(): KillSwitchStatusResponse {
    return this.service.buildStatus();
  }

  /**
   * POST /admin/kill-switch/pause-request — record a SAFE-DIRECTION pause INTENT (OQ-6 b). Emits a
   * value-free `admin.kill_switch_pause_requested` audit event. It does NOT change runtime — the
   * actual pause is applied via env/deploy (§2 #5). There is deliberately NO enable counterpart.
   */
  @Post("kill-switch/pause-request")
  @HttpCode(200)
  @RequireAdminRole("toggle_kill_switch")
  requestPause(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminKillSwitchPauseRequestSchema))
    dto: AdminKillSwitchPauseRequestDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminKillSwitchPauseRequestResponse> {
    return this.service.requestPause(admin.id, dto, ctx);
  }
}

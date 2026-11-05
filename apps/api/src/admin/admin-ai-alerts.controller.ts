import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AiAlertsService } from "../ai/ai-alerts.service";
import {
  AdminAiAlertsQuerySchema,
  type AdminAiAlertsQueryDto,
  type AdminAiAlertsStatus,
} from "./admin-ai-alerts.dto";

/**
 * Read-only LOUD-AI-ALERT API for the Admin Portal (B13, #2567) — per-task fallback
 * posture over a stated window, spend-cap trips, and the recent-alerts feed.
 *
 * ── READ-ONLY, LIKE THE DASHBOARD ────────────────────────────────────────────────────
 * Evaluation (the write path — raised/cleared verdicts) runs in `AiCostRecorder`'s wake
 * and never here: a GET that emits would make alerting depend on an admin polling, and
 * would put a system-actor write on a cacheable route. This endpoint only reads through
 * `AiAlertsService.status()`. No `admin.action_performed`, no written reason — there is
 * no admin write to audit.
 *
 * ── `read_entities`, NOT `read_events` ───────────────────────────────────────────────
 * The dashboard's documented call: aggregates + PII-free breach rows, no subject pivot,
 * the same allow-set as every other read floor route. A new capability would be an ADR
 * amendment for an allow-set identical to one that already exists.
 */
@Controller("admin/ai-alerts")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminAiAlertsController {
  constructor(private readonly alerts: AiAlertsService) {}

  /**
   * Active + recent AI alerts. `windowHours` (1..168, default the configured
   * `AI_FALLBACK_ALERT_WINDOW_HOURS`) scopes every block to the same trailing window.
   */
  @Get()
  @RequireAdminRole("read_entities")
  async status(
    @Query(new ZodValidationPipe(AdminAiAlertsQuerySchema))
    query: AdminAiAlertsQueryDto,
  ): Promise<AdminAiAlertsStatus> {
    return this.alerts.status(query.windowHours);
  }
}

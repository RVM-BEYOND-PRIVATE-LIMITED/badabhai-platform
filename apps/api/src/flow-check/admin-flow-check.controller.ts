import { Controller, Get, Header, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { FlowCheckThresholds } from "@badabhai/config";
import { FLOW_CHECK_NAMES, type FlowCheckName } from "@badabhai/event-schema";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import { FlowCheckEnabledGuard } from "./flow-check.flag";
import {
  FLOW_CHECK_MAX_DAYS,
  FLOW_CHECK_WINDOW_HOURS,
  FlowCheckService,
  type FlowCheckDay,
} from "./flow-check.service";

export const AdminFlowCheckQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(FLOW_CHECK_MAX_DAYS).default(FLOW_CHECK_MAX_DAYS),
  })
  .strict();
export type AdminFlowCheckQueryDto = z.infer<typeof AdminFlowCheckQuerySchema>;

/** `GET /admin/flow-check`: the last days of the flow check, newest first. Counts only. */
export interface AdminFlowCheck {
  /** The per-day counts cover this many hours before each run. */
  readonly window_hours: number;
  /** The thresholds in force NOW (each day also carries the ones it was checked against). */
  readonly thresholds: FlowCheckThresholds;
  /** Every check that can breach, in display order. */
  readonly checks: readonly FlowCheckName[];
  /** One entry per IST day that has a record, newest first; a day with no run is absent. */
  readonly days: readonly FlowCheckDay[];
}

/**
 * #2890 item 3 — the admin read of the daily flow check.
 *
 *   GET /admin/flow-check?days=1..14   read_events   the last days' counts, breaches and thresholds
 *
 * `read_events`, the dashboard's read floor (every admin role): it is counts and closed check names
 * only, the same class of figure as the breach counter it feeds, with no id, name or phone.
 *
 * THE ORDER: `AdminAuthGuard` (401 with no session), then `FlowCheckEnabledGuard` (a neutral 404 for
 * every role while `FLOW_CHECK_ENABLED` is off, before any pipe or query), then `AdminRolesGuard`.
 * A GET of the recorded days only: it reads `flow_check.day_recorded` through the one admin spine
 * reader, writes nothing and emits nothing. `Cache-Control: no-store`, like every admin read.
 */
@Controller("admin/flow-check")
@UseGuards(AdminAuthGuard, FlowCheckEnabledGuard, AdminRolesGuard)
export class AdminFlowCheckController {
  constructor(private readonly flowCheck: FlowCheckService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_events")
  async read(
    @Query(new ZodValidationPipe(AdminFlowCheckQuerySchema)) query: AdminFlowCheckQueryDto,
  ): Promise<AdminFlowCheck> {
    return {
      window_hours: FLOW_CHECK_WINDOW_HOURS,
      thresholds: this.flowCheck.thresholds(),
      checks: FLOW_CHECK_NAMES,
      days: await this.flowCheck.days(query.days, new Date()),
    };
  }
}

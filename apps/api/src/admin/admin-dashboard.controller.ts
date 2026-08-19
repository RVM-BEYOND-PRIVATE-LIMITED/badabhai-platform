import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminDashboardService } from "./admin-dashboard.service";
import {
  AdminDashboardSummaryQuerySchema,
  type AdminDashboardSummaryQueryDto,
} from "./admin-dashboard.dto";

/**
 * Read-only DASHBOARD API for the Admin Portal (BP-5) — platform AI spend (total, by provider,
 * by task type, cap breaches by reason) and platform volume (workers, profiles, postings,
 * applications, payers, unlocks, résumés).
 *
 * ── WHY `read_events` AND NOT `read_entities` OR A NEW CAPABILITY ────────────────────────
 * This route is the DASHBOARD-METRICS row of ADR-0025 Decision 3.1 ("Read metrics /
 * dashboards"), which is the same allow-set as `read_events` — all four roles — and it is the
 * capability `GET /admin/events/metrics` already declares for the strip this extends. Matching
 * it is what keeps one screen behind one capability: an analyst who can see the funnel and the
 * breach counter can see the spend and the headcount beside them, because they are the same
 * screen answering the same question.
 *
 * `read_entities` was the alternative and is the wrong shade. That capability is documented as
 * "the FACELESS ENTITY PROJECTIONS" — live per-row system-of-record state (this worker, this
 * payer, this posting). Nothing here is per-row: every number is an aggregate over a whole
 * table, and there is no entity to project. The two happen to share the same allow-set today,
 * which is exactly why picking by MEANING rather than by effect matters — the day one of them
 * narrows, every route named for the wrong one moves with it.
 *
 * A NEW `read_dashboard` capability is deliberately NOT minted: it would be a new row in the
 * signed ADR-0025 matrix (an ADR amendment) plus a key-parity change in `apps/admin-web`, to
 * express an allow-set identical to one that already exists.
 *
 * ── PII ──────────────────────────────────────────────────────────────────────────────────
 * COUNTS, ₹ AMOUNTS, ENUM LABELS AND TIMESTAMPS ONLY. There is not one id in this response —
 * no worker id, no payer id, no session id — so it cannot single anybody out and needs no
 * k-anon floor: an aggregate over "every worker" has no subject to protect. `provider` and
 * `task_type` are machine labels; the breach `reason` is a closed operational code.
 */
@Controller("admin/dashboard")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminDashboardController {
  constructor(private readonly service: AdminDashboardService) {}

  /**
   * Platform AI spend + volume. `windowDays` (1..90, default 30) scopes ONLY the cap-breach
   * counts; the cost totals and volume counts are all-time by construction.
   */
  @Get("summary")
  @RequireAdminRole("read_events")
  summary(
    @Query(new ZodValidationPipe(AdminDashboardSummaryQuerySchema))
    query: AdminDashboardSummaryQueryDto,
  ) {
    return this.service.summary(query);
  }
}

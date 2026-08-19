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
 * ── WHY `read_entities` AND NOT `read_events` OR A NEW CAPABILITY ────────────────────────
 * PICKED BY THE DATA IT EXPOSES, not by the shape of the response. Exactly ONE block here —
 * `cap_breaches` — reads the event spine. Everything else is live system-of-record state
 * (`workers`, `worker_profiles`, `job_postings`, `applications`, `payers`, `unlocks`,
 * `generated_resumes`) plus money out of `platform_ai_cost_totals`. That is the documented
 * meaning of `read_entities` (see `admin-capabilities.ts`): `read_events` is the append-only
 * audit spine, `read_entities` is live state, and the two are chosen by MEANING precisely
 * because they narrow independently.
 *
 * The in-repo precedent is decisive: `AdminFinanceController.{summary,ledger,orders}` is also
 * an aggregate over money tables, also not a per-row projection, and declares `read_entities`.
 * "Aggregates are not entity projections" would have made finance `read_events` too.
 *
 * NOT A PRIVILEGE CHANGE: the two allow-sets are identical today (all four roles), so nothing
 * a role can do moves. It is naming honesty — the day either capability narrows, a route
 * carrying the wrong name moves with the wrong one, invisibly.
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
  @RequireAdminRole("read_entities")
  summary(
    @Query(new ZodValidationPipe(AdminDashboardSummaryQuerySchema))
    query: AdminDashboardSummaryQueryDto,
  ) {
    return this.service.summary(query);
  }
}

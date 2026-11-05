import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminFunnelService } from "./admin-funnel.service";
import {
  AdminFunnelQuerySchema,
  type AdminFunnelQueryDto,
  type AdminOnboardingFunnel,
} from "./admin-funnel.dto";

/**
 * Read-only ONBOARDING-FUNNEL API for the Admin Portal (B14, #2568) — the 7 journey
 * steps counted across the whole base, where workers stop, split by trade / city /
 * language / app version.
 *
 * ── READ-ONLY, LIKE THE DASHBOARD ──────────────────────────────────────────────────
 * No evaluation, no writes, no audit event: this returns k-anon'd aggregates, and a
 * read is not a state change. (Contrast the per-worker journey, which emits
 * `admin.worker_journey_viewed` because it returns one person's behavioural profile.)
 *
 * ── `read_entities`, NOT `read_events` ───────────────────────────────────────────────
 * The dashboard's documented call: aggregates + pre-aggregated breach-free counts, no
 * subject pivot, the same allow-set as every other read floor route. A new capability
 * would be an ADR amendment for an allow-set identical to one that already exists.
 *
 * Every route: `AdminAuthGuard` + `AdminRolesGuard`, capability declared at the METHOD
 * level (a route that forgets the decorator is DENIED, never opened), and every one
 * is a GET.
 */
@Controller("admin/funnel")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminFunnelController {
  constructor(private readonly funnel: AdminFunnelService) {}

  /**
   * Onboarding funnel across all workers. `signupFrom`/`signupTo` scope the cohort to a
   * sign-up window (absent = the whole base); `testAccounts` excludes test traffic by
   * default. Every block is scoped to the same cohort, echoed back on the response.
   */
  @Get("onboarding")
  @RequireAdminRole("read_entities")
  onboarding(
    @Query(new ZodValidationPipe(AdminFunnelQuerySchema))
    query: AdminFunnelQueryDto,
  ): Promise<AdminOnboardingFunnel> {
    return this.funnel.onboardingFunnel(query);
  }
}

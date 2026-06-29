import { Body, Controller, Header, HttpCode, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminPiiRevealService } from "./admin-pii-reveal.service";
import {
  AdminPiiRevealParamsSchema,
  AdminPiiRevealSchema,
  type AdminPiiRevealDto,
  type AdminPiiRevealParamsDto,
  type AdminPiiRevealResponse,
} from "./admin-pii-reveal.dto";

/**
 * The reason-gated, audited, rate-capped worker-PII reveal (ADR-0025 ADMIN-3b, Decision 4) — the
 * SINGLE MOST SENSITIVE route in the system: it decrypts a worker's phone and returns it to ONE
 * authenticated admin. Behind a DEFAULT-OFF flag (`ADMIN_PII_REVEAL_ENABLED`); until its security
 * review passes it stays off and the route returns a NEUTRAL 404 (Control 1).
 *
 * RBAC (deny-by-default, ONE principal + ONE role per route): {@link AdminAuthGuard} (authn) +
 * {@link AdminRolesGuard} (authz) + EXACTLY ONE {@link RequireAdminRole}("reveal_pii"). Per the
 * capability matrix, `reveal_pii` is `super_admin` + `support` ONLY — `ops_admin` / `analyst` → 403.
 *
 * NON-SPOOFABLE actor/target: the actor is ALWAYS `@CurrentAdmin().id` (the session admin — never
 * a body field); the target is the VALIDATED path uuid (no IDOR). No body carries an actor/target.
 *
 * THE 8 CONTROLS (all mandatory):
 *   1. Flag-gated, default OFF → a NEUTRAL 404 when off (no oracle the feature exists).
 *   2. Reason-required, CLOSED enum (`AdminPiiRevealReason`); missing/invalid → 400, no reveal.
 *   3. Reveal-note PII-safe: optional `note` ≤280 AND residual-PII-rejected (400). The note is
 *      VALIDATED but NOT persisted and NEVER enters the event/log (the reason_code + event is the
 *      audit trail).
 *   4. Audit-BEFORE-decrypt: `admin.pii_viewed` is emitted + committed BEFORE the decrypt; an emit
 *      failure → no decrypt (fail closed). The audit row persists even if the response then fails.
 *   5. Per-admin rate cap (hour+day), fail-closed (Redis down → DENY + a PII-free breach event).
 *      Checked BEFORE the decrypt; an over-cap request reveals nothing.
 *   6. Single-subject, never bulk — ONE `:id`; there is no list/range/wildcard/batch entry point.
 *   7. No-oracle: an unknown worker returns the SAME neutral 404 as a denied/over-cap case.
 *   8. Decrypt at boundary only — the plaintext exists SOLELY in this HTTP response body;
 *      `Cache-Control: no-store` (set on the handler) keeps it out of any shared/browser cache.
 *
 * OQ-7 (the control that makes reason-gating MEANINGFUL): the product owner reviews the
 * `admin.pii_viewed` audit stream WEEKLY, retained 1 YEAR. Reason-gating is only meaningful because
 * every reveal is non-repudiably recorded on the spine (value-free) for that review.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminPiiRevealController {
  constructor(private readonly service: AdminPiiRevealService) {}

  /**
   * POST /admin/workers/:id/reveal-contact — reveal ONE worker's decrypted phone to the authed
   * admin. `Cache-Control: no-store` (Control 8) keeps the plaintext out of any cache. When the
   * flag is OFF this throws a NEUTRAL 404 BEFORE the service is reached (Control 1, no oracle).
   */
  @Post("workers/:id/reveal-contact")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("reveal_pii")
  revealContact(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminPiiRevealParamsSchema)) params: AdminPiiRevealParamsDto,
    @Body(new ZodValidationPipe(AdminPiiRevealSchema)) dto: AdminPiiRevealDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminPiiRevealResponse> {
    // Control 1: flag OFF → a NEUTRAL 404 (indistinguishable from a non-existent route). Checked
    // BEFORE any service work so the feature's existence is not observable while it is disabled.
    if (!this.service.isEnabled()) throw new NotFoundException("Not found");
    return this.service.revealContact(admin.id, params.id, dto, ctx);
  }
}

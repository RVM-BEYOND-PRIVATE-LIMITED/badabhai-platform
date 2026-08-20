import {
  type CanActivate,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { SERVER_CONFIG } from "../config/config.module";

/**
 * The `ADMIN_AI_TRACE_READ_ENABLED` master switch for the whole AI-trace surface (migration
 * 0083) — a NEUTRAL 404 for EVERY caller while it is off.
 *
 * ── WHY THIS IS A GUARD AND NOT AN `if` IN THE HANDLER ──────────────────────────────────
 * It was an `if` at the top of `readOne`, and the owner ruling it was written for — "a NEUTRAL
 * 404 when off, NOT a 403 — it must not confirm the feature exists" — was measurably false for
 * three of the four admin roles. Nest runs guards before handlers, so `@RequireAdminRole` fired
 * first and a lesser role got a `403 Admin role is not permitted for this capability`: a clean
 * oracle saying the route is real and merely closed. Measured against the real guard and the
 * real controller, flag off:
 *
 *     super_admin  guard PASS  → handler 404      ops_admin  guard 403  → handler never reached
 *     support      guard 403   → never reached    analyst    guard 403  → never reached
 *
 * A control that only holds for the one principal already entitled to the data is not the
 * control that was asked for. Ordering it AHEAD of {@link import("./admin-roles.guard")
 * .AdminRolesGuard} in `@UseGuards` is the entire fix, and it can only be got right in the guard
 * chain — no handler-body check can run before a guard.
 *
 * ── THE ORDER, AND WHY 401 STILL COMES FIRST ───────────────────────────────────────────
 * `@UseGuards(AdminAuthGuard, AdminAiTraceFlagGuard, AdminRolesGuard)`:
 *
 *   1. no session          → 401. An unauthenticated caller learns nothing about any admin
 *                            route from a 401; hiding the flag behind it would only make the
 *                            whole admin surface answer 404 to the internet, which is a
 *                            different (and worse) API.
 *   2. flag off            → 404, IDENTICALLY for all four roles. Nothing distinguishes it from
 *                            "no such trace" or "over your cap" — same status, same body, and
 *                            the route also sets `Cache-Control: no-store` on the detail leg.
 *   3. flag on, lesser role → 403, which is now the CORRECT answer: with the feature on, the
 *                            surface is legitimately known to exist and "not you" is honest.
 *
 * ── NO CAPABILITY METADATA HERE ────────────────────────────────────────────────────────
 * This guard reads one boolean and knows nothing about roles; `AdminRolesGuard` stays the single
 * place a capability is resolved (`ADMIN_CAPABILITY_MATRIX`). Two guards, two concerns — a flag
 * guard that also checked a role would be a second, forkable copy of the authz rule.
 */
@Injectable()
export class AdminAiTraceFlagGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(): boolean {
    // The SAME neutral shape `AdminAiTracesService.neutralNotFound()` throws, so the flag is not
    // distinguishable from an unknown id or an exhausted cap by status, body or header.
    if (!this.config.ADMIN_AI_TRACE_READ_ENABLED) throw new NotFoundException("Not found");
    return true;
  }
}

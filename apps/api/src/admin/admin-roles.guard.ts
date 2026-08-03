import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { type AdminCapability, can } from "./admin-capabilities";

/** Reflector metadata key for the capability declared by {@link RequireAdminRole}. */
export const ADMIN_CAPABILITY_KEY = "admin_capability";

/**
 * Declares the CAPABILITY a route requires (ADR-0025 Decision 3.2) — the vertical-authz
 * primitive for the Admin Ops Portal. Pair it with {@link AdminRolesGuard}, AFTER
 * {@link import("./admin-auth.guard").AdminAuthGuard}, e.g. for a PII-reveal route:
 *
 *   @UseGuards(AdminAuthGuard, AdminRolesGuard)
 *   @RequireAdminRole("reveal_pii")
 *   @Post("workers/:id/reveal") ...
 *
 * It declares the capability, not raw roles, so the role→capability mapping stays in ONE
 * place ({@link import("./admin-capabilities").ADMIN_CAPABILITY_MATRIX}). The guard then
 * resolves it via `can(role, capability)` — deny-by-default.
 */
export const RequireAdminRole = (capability: AdminCapability): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_CAPABILITY_KEY, capability);

/**
 * VERTICAL authz for admin routes (ADR-0025 Decision 3.2). Runs AFTER {@link AdminAuthGuard}
 * and reads the capability declared by {@link RequireAdminRole}; rejects (403) when the
 * authenticated admin's role is not permitted that capability per the single-source matrix.
 *
 * DENY-BY-DEFAULT + fail-closed, on EVERY branch:
 *   - NO `@RequireAdminRole` metadata on a route → **403**. A route that mounts this guard and
 *     declares no capability is a MISCONFIGURATION, and the safe reading of a missing
 *     declaration is "nobody", not "everybody". This used to return true, which meant a single
 *     forgotten decorator silently exposed a privileged route to all four roles — an open route
 *     with a green test, because the route-coverage build-blocker (must-fix #4) enumerates by
 *     module membership and cannot see a controller registered outside `AdminModule`.
 *     There is deliberately **no opt-out decorator**: a route that legitimately needs no
 *     capability must not mount this guard at all (that is what the three session routes —
 *     `refresh`/`logout`/`me` — already do, using `AdminAuthGuard` alone).
 *   - `req.admin` absent → 401 (guards were misordered or auth skipped — fail closed).
 *   - the role is not allowed the capability (incl. an unknown/edge role) → 403. `can()` is
 *     deny-by-default, so an unlisted capability or role is denied, never defaulted.
 *
 * The 403 is deliberately indistinguishable from a real authz denial: a misconfigured route
 * must not become an oracle that tells a caller the route exists but is unguarded.
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const capability = this.reflector.getAllAndOverride<AdminCapability | undefined>(
      ADMIN_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No capability declared on a route that mounted this guard → MISCONFIGURATION → deny.
    // Checked BEFORE req.admin so an unguarded-but-mounted route cannot be probed for the
    // difference between "no session" (401) and "no capability declared" (403).
    if (!capability) {
      throw new ForbiddenException("Admin role is not permitted for this capability");
    }

    const req = context.switchToHttp().getRequest<Request>();
    const admin = req.admin;
    // Defense-in-depth: AdminAuthGuard runs first and attaches req.admin. If it is absent the
    // guards were misordered (or auth skipped) — fail closed rather than allow.
    if (!admin) {
      throw new UnauthorizedException("No authenticated admin on request");
    }

    if (!can(admin.role, capability)) {
      throw new ForbiddenException("Admin role is not permitted for this capability");
    }
    return true;
  }
}

import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { AdminKillSwitchController } from "./admin-kill-switch.controller";

/**
 * Per-ROLE authz for the ADMIN-3c kill-switch routes (ADR-0025 OQ-6). Drives the REAL
 * {@link AdminRolesGuard} with each route's REAL declared @RequireAdminRole("toggle_kill_switch"):
 *   - toggle_kill_switch → super_admin ALLOWED (break-glass); ops_admin + support + analyst DENIED;
 *   - an unauthenticated request (no req.admin) → 401 (fail closed).
 * `toggle_kill_switch` is super_admin-ONLY in the capability matrix — the tightest gate.
 */

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

const ROUTES = ["status", "requestPause"] as const;

function declaredCapability(method: string): AdminCapability {
  const proto = AdminKillSwitchController.prototype as unknown as Record<string, object>;
  const cap =
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as AdminCapability | undefined) ??
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminKillSwitchController) as
      | AdminCapability
      | undefined);
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

function ctxFor(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declaredCapability(method), handler);
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminKillSwitchController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());

describe("ADMIN-3c authz — kill-switch routes are toggle_kill_switch (super_admin ONLY)", () => {
  it("both routes declare exactly the toggle_kill_switch capability", () => {
    for (const route of ROUTES) {
      expect(declaredCapability(route)).toBe("toggle_kill_switch");
    }
  });

  it("super_admin ALLOWED on both routes", () => {
    for (const route of ROUTES) {
      expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    }
  });

  it("ops_admin + support + analyst DENIED (403) — toggle_kill_switch is break-glass super-only", () => {
    for (const route of ROUTES) {
      for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
        expect(() => guard.canActivate(ctxFor(route, admin(role)))).toThrow(ForbiddenException);
      }
    }
  });

  it("unauthenticated (no req.admin) → 401 (fail closed) on both routes", () => {
    for (const route of ROUTES) {
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    }
  });
});

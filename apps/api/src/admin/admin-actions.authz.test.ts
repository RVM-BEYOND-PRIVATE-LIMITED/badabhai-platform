import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { AdminActionsController } from "./admin-actions.controller";

/**
 * Per-ROLE authz matrix for the ADMIN-3a entity-action routes (ADR-0025 Decision 3). Drives the
 * REAL {@link AdminRolesGuard} with each route's REAL declared @RequireAdminRole capability:
 *   - suspend_payer / grant_credits / force_close_posting / flag_worker → super_admin + ops_admin
 *     ALLOWED; support + analyst DENIED (403);
 *   - manage_admins (invite/role/suspend admin) → super_admin ONLY; ops_admin + support + analyst
 *     DENIED (403);
 *   - an unauthenticated request (no req.admin) → 401 (fail closed) on every route.
 */

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

/** The capability a route handler declares (method ∪ class), via real reflector metadata. */
function declaredCapability(method: string): AdminCapability {
  const proto = AdminActionsController.prototype as unknown as Record<string, object>;
  const cap =
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as AdminCapability | undefined) ??
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminActionsController) as AdminCapability | undefined);
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

/** An ExecutionContext whose handler carries the route's declared capability. */
function ctxFor(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declaredCapability(method), handler);
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminActionsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());

/** suspend_payer / grant_credits / force_close_posting / flag_worker (super_admin + ops_admin). */
const OPS_WRITE_ROUTES = [
  "suspendPayer",
  "reinstatePayer",
  "grantCredits",
  "forceClosePosting",
  "flagWorker",
  "unflagWorker",
] as const;

/** manage_admins (super_admin ONLY). */
const MANAGE_ADMINS_ROUTES = ["inviteAdmin", "changeAdminRole", "suspendAdmin"] as const;

const ALLOWED_OPS_WRITE: AdminRole[] = ["super_admin", "ops_admin"];
const DENIED_OPS_WRITE: AdminRole[] = ["support", "analyst"];

describe("ADMIN-3a authz matrix — ops-write actions (super_admin + ops_admin)", () => {
  for (const route of OPS_WRITE_ROUTES) {
    it(`${route}: super_admin + ops_admin ALLOWED`, () => {
      for (const role of ALLOWED_OPS_WRITE) {
        expect(guard.canActivate(ctxFor(route, admin(role)))).toBe(true);
      }
    });
    it(`${route}: support + analyst DENIED (403)`, () => {
      for (const role of DENIED_OPS_WRITE) {
        expect(() => guard.canActivate(ctxFor(route, admin(role)))).toThrow(ForbiddenException);
      }
    });
    it(`${route}: unauthenticated → 401`, () => {
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    });
  }
});

describe("ADMIN-3a authz matrix — manage_admins (super_admin ONLY)", () => {
  for (const route of MANAGE_ADMINS_ROUTES) {
    it(`${route}: super_admin ALLOWED`, () => {
      expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    });
    it(`${route}: ops_admin + support + analyst DENIED (403)`, () => {
      for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
        expect(() => guard.canActivate(ctxFor(route, admin(role)))).toThrow(ForbiddenException);
      }
    });
    it(`${route}: unauthenticated → 401`, () => {
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    });
  }
});

describe("ADMIN-3a authz matrix — declared capabilities (exact, least-privilege)", () => {
  it("ops-write routes declare suspend_payer/grant_credits/force_close_posting/flag_worker", () => {
    expect(declaredCapability("suspendPayer")).toBe("suspend_payer");
    expect(declaredCapability("reinstatePayer")).toBe("suspend_payer");
    expect(declaredCapability("grantCredits")).toBe("grant_credits");
    expect(declaredCapability("forceClosePosting")).toBe("force_close_posting");
    expect(declaredCapability("flagWorker")).toBe("flag_worker");
    expect(declaredCapability("unflagWorker")).toBe("flag_worker");
  });
  it("admin-management routes declare manage_admins (super-only)", () => {
    for (const r of MANAGE_ADMINS_ROUTES) expect(declaredCapability(r)).toBe("manage_admins");
  });
});

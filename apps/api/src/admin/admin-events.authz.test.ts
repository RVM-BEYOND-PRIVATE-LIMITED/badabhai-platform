import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { AdminEventsController } from "./admin-events.controller";

/**
 * Per-ROLE authz matrix for the ADMIN-2 event-spine routes (ADR-0025). Drives the REAL
 * {@link AdminRolesGuard} with each route's REAL declared @RequireAdminRole capability:
 *   - analyst + support may read events/trace/timeline/metrics (`read_events`, the read floor),
 *   - `export` is allowed ONLY for super_admin/ops_admin; support/analyst → 403,
 *   - an unauthenticated request (no req.admin) → 401 (fail closed).
 */

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

/** The capability a route handler declares (method ∪ class), via real reflector metadata. */
function declaredCapability(method: string): AdminCapability {
  const proto = AdminEventsController.prototype as unknown as Record<string, object>;
  const cap =
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as AdminCapability | undefined) ??
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminEventsController) as AdminCapability | undefined);
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
    getClass: () => AdminEventsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());
const READ_ROUTES = ["list", "getOne", "trace", "timeline", "metrics"] as const;

describe("ADMIN-2 authz matrix — read routes (read_events floor)", () => {
  for (const route of READ_ROUTES) {
    it(`${route}: ALL four roles pass`, () => {
      for (const role of ROLES) {
        expect(guard.canActivate(ctxFor(route, admin(role)))).toBe(true);
      }
    });
    it(`${route}: unauthenticated → 401`, () => {
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    });
  }
});

describe("ADMIN-2 authz matrix — export (super_admin/ops_admin ONLY)", () => {
  it("super_admin + ops_admin are ALLOWED to export", () => {
    expect(guard.canActivate(ctxFor("export", admin("super_admin")))).toBe(true);
    expect(guard.canActivate(ctxFor("export", admin("ops_admin")))).toBe(true);
  });

  it("support + analyst are DENIED export (403) — the reveal/read roles cannot bulk-export", () => {
    expect(() => guard.canActivate(ctxFor("export", admin("support")))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor("export", admin("analyst")))).toThrow(ForbiddenException);
  });

  it("unauthenticated export → 401", () => {
    expect(() => guard.canActivate(ctxFor("export", undefined))).toThrow(UnauthorizedException);
  });

  it("the export route really declares the `export` capability (least-privilege)", () => {
    expect(declaredCapability("export")).toBe("export");
    for (const r of READ_ROUTES) expect(declaredCapability(r)).toBe("read_events");
  });
});

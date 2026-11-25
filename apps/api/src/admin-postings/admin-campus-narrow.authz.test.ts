import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin/admin-roles.guard";
import type { AdminCapability } from "../admin/admin-capabilities";
import { AdminCampusNarrowController } from "./admin-campus-narrow.controller";

/**
 * #3033 — the Campus narrow queue routes: guarded, exactly ONE method-level capability
 * (`manage_postings`), super_admin + ops_admin allowed, support + analyst 403, no session
 * 401 — the same people who already hide, verify and open postings.
 */

const ROUTES = ["queue", "narrow"] as const;
const proto = AdminCampusNarrowController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const guard = new AdminRolesGuard(new Reflector());

function ctxFor(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(
    ADMIN_CAPABILITY_KEY,
    Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!),
    handler,
  );
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminCampusNarrowController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#3033 campus narrow routes — authz", () => {
  it("the controller exposes exactly the queue and the narrow write", () => {
    const methods = Object.getOwnPropertyNames(AdminCampusNarrowController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminCampusNarrowController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("every route declares EXACTLY ONE method-level @RequireAdminRole('manage_postings')", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCampusNarrowController)).toBeUndefined();
    for (const route of ROUTES) {
      const cap = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as
        | AdminCapability
        | undefined;
      expect(cap, route).toBe("manage_postings");
    }
  });

  it.each(ROUTES)(
    "%s: super_admin + ops_admin allowed; support + analyst 403; no session 401",
    (route) => {
      expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
      expect(guard.canActivate(ctxFor(route, admin("ops_admin")))).toBe(true);
      expect(() => guard.canActivate(ctxFor(route, admin("support")))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    },
  );
});

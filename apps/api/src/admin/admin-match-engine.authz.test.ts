import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import type { AdminCapability } from "./admin-capabilities";
import { AdminMatchEngineController } from "./admin-match-engine.controller";

/**
 * Per-ROLE authz for the Engine view reads, driving the REAL {@link AdminRolesGuard} with each
 * route's REAL declared capability. They sit on the `read_entities` floor (all four roles); no
 * new capability is minted, and none of them is identity, PII reveal or a write.
 */

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const ROUTES = ["listRecentWorkers", "getWorkerView", "getPostingView"] as const;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

function declared(method: string): AdminCapability {
  const proto = AdminMatchEngineController.prototype as unknown as Record<string, object>;
  const cap = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as
    | AdminCapability
    | undefined;
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

function ctxFor(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declared(method), handler);
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminMatchEngineController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());

describe("Engine view authz — the reads sit on the `read_entities` floor", () => {
  for (const route of ROUTES) {
    it(`${route} declares read_entities`, () => {
      expect(declared(route)).toBe("read_entities");
    });

    it(`${route}: every admin role passes`, () => {
      for (const role of ROLES) expect(guard.canActivate(ctxFor(route, admin(role)))).toBe(true);
    });

    it(`${route}: unauthenticated → 401`, () => {
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    });

    it(`${route}: a role without the capability → 403 (deny-by-default)`, () => {
      const rogue = { id: "a", role: "root" as AdminRole, sid: "s" };
      expect(() => guard.canActivate(ctxFor(route, rogue))).toThrow(ForbiddenException);
    });
  }

  it("the controller is behind AdminAuthGuard and AdminRolesGuard", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminMatchEngineController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });
});

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import { AdminTradeReleaseController } from "./admin-trade-release.controller";
import { AdminSetTradeReleaseSchema } from "./admin-trade-release.dto";

/**
 * #3002 `/admin/trade-release` — guarded, ONE method-level capability each
 * (`manage_trade_release`, super_admin only), the actor always the session admin, and a body
 * that names exactly one trade kind.
 */

const ROUTES = ["listReleases", "setRelease"] as const;
const proto = AdminTradeReleaseController.prototype as unknown as Record<string, object>;
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
    getClass: () => AdminTradeReleaseController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#3002 /admin/trade-release — authz", () => {
  it("exposes exactly the list and the set", () => {
    const methods = Object.getOwnPropertyNames(AdminTradeReleaseController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminTradeReleaseController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("both routes declare manage_trade_release; none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminTradeReleaseController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!), route).toBe(
        "manage_trade_release",
      );
    }
  });

  it.each(ROUTES)("%s: super_admin only; every other role 403; no session 401", (route) => {
    expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() => guard.canActivate(ctxFor(route, admin(role))), role).toThrow(ForbiddenException);
    }
    expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });
});

describe("#3002 /admin/trade-release — the controller", () => {
  function controller() {
    const service = {
      getAll: vi.fn(async () => ({ releases: [] })),
      set: vi.fn(async () => ({
        release: {
          role_kind: "cnc_turner",
          posting_enabled: true,
          form_enabled: false,
          updated_by: "session-admin",
          updated_at: new Date(0).toISOString(),
        },
        changed: true,
      })),
    };
    return { service, controller: new AdminTradeReleaseController(service as never) };
  }

  it("the actor is the session admin, never a body field", async () => {
    const { service, controller: c } = controller();
    await c.setRelease(
      { id: "session-admin", role: "super_admin", sid: "s" },
      { role_kind: "cnc_turner", posting_enabled: true, form_enabled: false },
      {} as never,
    );
    expect(service.set).toHaveBeenCalledWith(
      "session-admin",
      { roleKind: "cnc_turner", postingEnabled: true, formEnabled: false },
      {},
    );
  });
});

describe("#3002 /admin/trade-release — the body", () => {
  const valid = { role_kind: "cnc_turner", posting_enabled: true, form_enabled: false };

  it("takes one known trade kind and the two flags", () => {
    expect(AdminSetTradeReleaseSchema.safeParse(valid).success).toBe(true);
    expect(
      AdminSetTradeReleaseSchema.safeParse({ ...valid, role_kind: "gear_cutting_operator" })
        .success,
    ).toBe(true);
  });

  it("refuses an unknown kind, missing flags and an admin id in the body", () => {
    expect(
      AdminSetTradeReleaseSchema.safeParse({ ...valid, role_kind: "not_a_trade" }).success,
    ).toBe(false);
    expect(AdminSetTradeReleaseSchema.safeParse({ role_kind: "cnc_turner" }).success).toBe(false);
    expect(AdminSetTradeReleaseSchema.safeParse({ ...valid, admin_id: "x" }).success).toBe(false);
  });
});

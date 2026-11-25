import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";

import { AdminSetAppReleasePolicySchema } from "../../app-version/app-version.dto";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import { AdminAppReleasePolicyController } from "./admin-app-release-policy.controller";

/**
 * #3048 `/admin/app-release-policy` — guarded, ONE method-level capability each
 * (`manage_app_release_policy`, super_admin only), the actor always the session admin, and a
 * body that names exactly one app and platform with every field stated.
 */

const ROUTES = ["listPolicies", "setPolicy"] as const;
const proto = AdminAppReleasePolicyController.prototype as unknown as Record<string, object>;
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
    getClass: () => AdminAppReleasePolicyController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#3048 /admin/app-release-policy — authz", () => {
  it("exposes exactly the list and the set", () => {
    const methods = Object.getOwnPropertyNames(AdminAppReleasePolicyController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminAppReleasePolicyController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("both routes declare manage_app_release_policy; none on the class", () => {
    expect(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminAppReleasePolicyController),
    ).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!), route).toBe(
        "manage_app_release_policy",
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

describe("#3048 /admin/app-release-policy — the controller", () => {
  it("the actor is the session admin, never a body field", async () => {
    const service = {
      getAll: vi.fn(async () => ({ policies: [] })),
      set: vi.fn(async () => ({ policy: {} as never, changed: true })),
    };
    const c = new AdminAppReleasePolicyController(service as never);
    await c.setPolicy(
      { id: "session-admin", role: "super_admin", sid: "s" },
      {
        app: "worker",
        platform: "android",
        min_supported_build: 5,
        latest_build: 6,
        store_url: null,
        message_key: "update_default",
      },
      {} as never,
    );
    expect(service.set).toHaveBeenCalledWith(
      "session-admin",
      "worker",
      "android",
      { minSupportedBuild: 5, latestBuild: 6, storeUrl: null, messageKey: "update_default" },
      {},
    );
  });
});

describe("#3048 /admin/app-release-policy — the body", () => {
  const valid = {
    app: "payer",
    platform: "ios",
    min_supported_build: 10,
    latest_build: 12,
    store_url: "https://apps.apple.com/app/id1",
    message_key: "update_default",
  };

  it("takes one app and platform with every field stated", () => {
    expect(AdminSetAppReleasePolicySchema.safeParse(valid).success).toBe(true);
    expect(
      AdminSetAppReleasePolicySchema.safeParse({
        ...valid,
        min_supported_build: 0,
        latest_build: 0,
        store_url: null,
      }).success,
    ).toBe(true);
  });

  it("refuses a latest build below the minimum", () => {
    expect(
      AdminSetAppReleasePolicySchema.safeParse({ ...valid, min_supported_build: 13 }).success,
    ).toBe(false);
  });

  it("refuses unknown values, bad numbers, a non-https link, a missing field and an admin id", () => {
    for (const over of [
      { app: "agent" },
      { platform: "web" },
      { min_supported_build: -1 },
      { latest_build: 1.5 },
      { latest_build: "12" },
      { latest_build: 2_147_483_648 },
      { store_url: "http://example.com/app.apk" },
      { store_url: "https://example.com/a b" },
      { store_url: `https://example.com/${"a".repeat(600)}` },
      { message_key: "Update Now" },
      { admin_id: "x" },
    ]) {
      expect(
        AdminSetAppReleasePolicySchema.safeParse({ ...valid, ...over }).success,
        JSON.stringify(over).slice(0, 60),
      ).toBe(false);
    }
    const { store_url: _omit, ...missing } = valid;
    expect(AdminSetAppReleasePolicySchema.safeParse(missing).success).toBe(false);
  });
});

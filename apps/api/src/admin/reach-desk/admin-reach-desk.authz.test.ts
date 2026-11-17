import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import {
  ReachAttemptSchema,
  ReachCasesQuerySchema,
  ReachResolveSchema,
} from "../../reach-desk/reach-desk.dto";
import { AdminReachDeskController } from "./admin-reach-desk.controller";

/**
 * #2750 items 7 and 12 — `/admin/desk/reach-cases`: guarded, ONE method-level capability each
 * (`work_reach_desk`: super_admin, ops_admin and support, owner ruling 2026-11-17; analyst denied),
 * the actor always the session admin, closed codes only in the bodies.
 */

const ROUTES = ["listReachCases", "getReachCase", "logReachAttempt", "resolveReachCase"] as const;
const proto = AdminReachDeskController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const guard = new AdminRolesGuard(new Reflector());
const CASE = "ca000000-0000-4000-8000-000000000001";
const REASON = "Number switched off on three calls";

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
    getClass: () => AdminReachDeskController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#2750 /admin/desk/reach-cases — authz", () => {
  it("exposes exactly the queue, the case, the attempt and the close", () => {
    const methods = Object.getOwnPropertyNames(AdminReachDeskController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("mounts the issue's paths under /admin/desk/reach-cases (#2750 item 8)", () => {
    expect(Reflect.getMetadata("path", AdminReachDeskController)).toBe("admin");
    expect(ROUTES.map((r) => Reflect.getMetadata("path", proto[r]!))).toEqual([
      "desk/reach-cases",
      "desk/reach-cases/:id",
      "desk/reach-cases/:id/attempts",
      "desk/reach-cases/:id/resolve",
    ]);
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminReachDeskController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("every route declares work_reach_desk; none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminReachDeskController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!), route).toBe(
        "work_reach_desk",
      );
    }
  });

  it.each(ROUTES)("%s: super_admin, ops_admin and support; analyst 403; no session 401", (route) => {
    for (const role of ["super_admin", "ops_admin", "support"] as AdminRole[]) {
      expect(guard.canActivate(ctxFor(route, admin(role))), role).toBe(true);
    }
    expect(() => guard.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });
});

describe("#2750 /admin/desk/reach-cases — the controller", () => {
  function controller() {
    const service = {
      list: vi.fn(async () => ({ cases: [], next_cursor: null })),
      get: vi.fn(),
      logAttempt: vi.fn(),
      resolveByDesk: vi.fn(),
    };
    return { service, controller: new AdminReachDeskController(service as never) };
  }

  it("the attempt and the close name the session admin, never a body field", async () => {
    const { service, controller: c } = controller();
    const me = { id: "session-admin", role: "support", sid: "s" } as AuthenticatedAdmin;
    await c.logReachAttempt(me, CASE, { result: "busy" });
    expect(service.logAttempt).toHaveBeenCalledWith("session-admin", CASE, "busy");
    await c.resolveReachCase(me, CASE, { outcome: "not_reached", reason_text: REASON }, {} as never);
    expect(service.resolveByDesk).toHaveBeenCalledWith(
      "session-admin",
      CASE,
      "not_reached",
      REASON,
      {},
    );
  });

  it("the queue defaults to open cases", async () => {
    const { service, controller: c } = controller();
    await c.listReachCases(ReachCasesQuerySchema.parse({}));
    expect(service.list).toHaveBeenCalledWith({ status: "open", limit: 50 });
  });
});

describe("#2750 /admin/desk/reach-cases — the bodies", () => {
  it("an attempt is a closed result code; no note can ride along", () => {
    expect(ReachAttemptSchema.safeParse({ result: "no_answer" }).success).toBe(true);
    expect(ReachAttemptSchema.safeParse({ result: "answered" }).success).toBe(false);
    expect(ReachAttemptSchema.safeParse({ result: "busy", note: "call back at 6" }).success).toBe(
      false,
    );
  });

  it("a close is a closed outcome with a written reason free of hard identifiers", () => {
    const valid = { outcome: "reached_declined", reason_text: REASON };
    expect(ReachResolveSchema.safeParse(valid).success).toBe(true);
    expect(ReachResolveSchema.safeParse({ ...valid, outcome: "open" }).success).toBe(false);
    expect(ReachResolveSchema.safeParse({ ...valid, reason_text: "short" }).success).toBe(false);
    expect(
      ReachResolveSchema.safeParse({ ...valid, reason_text: "He answered on 9876543210 later" })
        .success,
    ).toBe(false);
    expect(ReachResolveSchema.safeParse({ ...valid, admin_id: "x" }).success).toBe(false);
  });

  it("the queue query is strict and capped", () => {
    expect(ReachCasesQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(ReachCasesQuerySchema.safeParse({ status: "pending" }).success).toBe(false);
    expect(ReachCasesQuerySchema.safeParse({ payer_id: "x" }).success).toBe(false);
  });
});

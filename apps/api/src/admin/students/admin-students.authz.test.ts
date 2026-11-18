import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import { AdminStudentsController } from "./admin-students.controller";
import {
  AdminBulkStudentVisibilitySchema,
  AdminListStudentsQuerySchema,
  AdminSetStudentVisibilitySchema,
} from "./admin-students.dto";

/**
 * #2887 — `/admin/students/*`: guarded, ONE method-level capability each
 * (`manage_student_visibility`, super_admin and ops_admin), the actor always the session admin,
 * and a bulk body that names exactly one selector.
 */

const ROUTES = ["listStudents", "setStudentVisibility", "setBulkStudentVisibility"] as const;
const proto = AdminStudentsController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const guard = new Reflector();
const rolesGuard = new AdminRolesGuard(guard);
const WORKER = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const REASON = "Placement team cleared the November batch";

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
    getClass: () => AdminStudentsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#2887 /admin/students — authz", () => {
  it("exposes exactly the list, the single switch and the bulk switch", () => {
    const methods = Object.getOwnPropertyNames(AdminStudentsController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminStudentsController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("every route declares manage_student_visibility; none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminStudentsController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!), route).toBe(
        "manage_student_visibility",
      );
    }
  });

  it.each(ROUTES)("%s: super_admin and ops_admin; support and analyst 403; no session 401", (route) => {
    for (const role of ["super_admin", "ops_admin"] as AdminRole[]) {
      expect(rolesGuard.canActivate(ctxFor(route, admin(role))), role).toBe(true);
    }
    for (const role of ["support", "analyst"] as AdminRole[]) {
      expect(() => rolesGuard.canActivate(ctxFor(route, admin(role))), role).toThrow(
        ForbiddenException,
      );
    }
    expect(() => rolesGuard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });
});

describe("#2887 /admin/students — the controller", () => {
  function controller() {
    const service = {
      list: vi.fn(async () => ({ students: [], nextCursor: null })),
      setOne: vi.fn(async () => ({
        student: {
          workerId: WORKER,
          visible: true,
          batchId: BATCH,
          branch: null,
          course: null,
          changedAt: new Date("2026-11-17T10:00:00Z"),
          createdAt: new Date("2026-11-17T09:00:00Z"),
        },
        changed: true,
      })),
      setBulk: vi.fn(async () => ({ changed: 3 })),
    };
    return { service, controller: new AdminStudentsController(service as never) };
  }

  it("the single switch: the actor is the session admin; the answer has no name or phone", async () => {
    const { service, controller: c } = controller();
    const out = await c.setStudentVisibility(
      { id: "session-admin", role: "ops_admin", sid: "s" },
      WORKER,
      { visible: true, reason_text: REASON },
      {} as never,
    );
    expect(service.setOne).toHaveBeenCalledWith(
      "session-admin",
      WORKER,
      { visible: true, reason: REASON },
      {},
    );
    expect(out).toEqual({
      student: {
        worker_id: WORKER,
        visible: true,
        batch_id: BATCH,
        branch: null,
        course: null,
        changed_at: "2026-11-17T10:00:00.000Z",
      },
      changed: true,
    });
  });

  it("the bulk switch maps each selector", async () => {
    const { service, controller: c } = controller();
    const who = admin("super_admin");
    await c.setBulkStudentVisibility(who, { visible: true, reason_text: REASON, batch_id: BATCH }, {} as never);
    await c.setBulkStudentVisibility(who, { visible: false, reason_text: REASON, branch: "Pune" }, {} as never);
    await c.setBulkStudentVisibility(who, { visible: true, reason_text: REASON, course: "CAD" }, {} as never);
    expect(service.setBulk.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { kind: "batch", batchId: BATCH },
      { kind: "branch", branch: "Pune" },
      { kind: "course", course: "CAD" },
    ]);
  });

  it("the list passes visible through as a boolean", async () => {
    const { service, controller: c } = controller();
    await c.listStudents({ visible: "false", limit: 50 });
    expect(service.list).toHaveBeenCalledWith({ visible: false, limit: 50 });
  });
});

describe("#2887 /admin/students — the bodies", () => {
  it("the bulk body names exactly one selector", () => {
    const base = { visible: true, reason_text: REASON };
    expect(AdminBulkStudentVisibilitySchema.safeParse({ ...base, batch_id: BATCH }).success).toBe(true);
    expect(AdminBulkStudentVisibilitySchema.safeParse(base).success).toBe(false);
    expect(
      AdminBulkStudentVisibilitySchema.safeParse({ ...base, batch_id: BATCH, branch: "Pune" }).success,
    ).toBe(false);
  });

  it("refuses an admin id in the body and a short reason", () => {
    expect(
      AdminSetStudentVisibilitySchema.safeParse({ visible: true, reason_text: REASON, admin_id: "x" })
        .success,
    ).toBe(false);
    expect(AdminSetStudentVisibilitySchema.safeParse({ visible: true, reason_text: "short" }).success).toBe(
      false,
    );
  });

  it("the list query is strict and capped", () => {
    expect(AdminListStudentsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(AdminListStudentsQuerySchema.safeParse({ name: "Ravi" }).success).toBe(false);
    expect(AdminListStudentsQuerySchema.parse({}).limit).toBe(50);
  });
});

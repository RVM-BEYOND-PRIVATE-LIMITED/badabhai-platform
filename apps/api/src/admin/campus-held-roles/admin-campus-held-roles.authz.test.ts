import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { CAMPUS_POSTING_CREATED_AUDIT_ACTION } from "@badabhai/db";
import { LIVE_POSTING_TRADE_KINDS } from "@badabhai/taxonomy";
import { CAMPUS_POSTING_CREATED_ACTION } from "../../campus-link/campus-postings.repository";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import { AdminCampusHeldRolesController } from "./admin-campus-held-roles.controller";
import { AdminCampusHeldRolesService } from "./admin-campus-held-roles.service";

/**
 * #3014 `GET /admin/campus-roles/held` — guarded, one method-level capability (`read_entities`),
 * names and counts only.
 */

const proto = AdminCampusHeldRolesController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const guard = new AdminRolesGuard(new Reflector());

function ctxFor(who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(
    ADMIN_CAPABILITY_KEY,
    Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto["held"]!),
    handler,
  );
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminCampusHeldRolesController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#3014 /admin/campus-roles/held — authz", () => {
  it("exposes exactly the one read", () => {
    const methods = Object.getOwnPropertyNames(AdminCampusHeldRolesController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods).toEqual(["held"]);
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminCampusHeldRolesController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("declares read_entities on the route; none on the class", () => {
    expect(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCampusHeldRolesController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto["held"]!)).toBe("read_entities");
  });

  it("refuses no session (401) and lets every admin role read", () => {
    expect(() => guard.canActivate(ctxFor(undefined))).toThrow(UnauthorizedException);
    for (const role of ["super_admin", "ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(guard.canActivate(ctxFor(admin(role))), role).toBe(true);
    }
  });

  it("reads the Campus posting by the same audit action Campus writes", () => {
    expect(CAMPUS_POSTING_CREATED_AUDIT_ACTION).toBe(CAMPUS_POSTING_CREATED_ACTION);
  });
});

describe("#3014 AdminCampusHeldRolesService", () => {
  it("answers held names and counts only, from grouped rows and the release switch", async () => {
    const rows: Record<string, unknown[]> = {
      jobs: [
        { role_title: "Senior CNC Operator", n: 3 },
        { role_title: "CNC Turner", n: 2 },
        { role_title: "Quality Engineer", n: 1 },
      ],
      students: [{ role_label: "Senior CNC Operator", course: "CNC, Spoken English", n: 2 }],
    };
    const db = {
      execute: async (q: unknown) => {
        const text = JSON.stringify(q);
        return text.includes("worker_origins") ? rows.students : rows.jobs;
      },
    };
    const releases = { postingEnabledKinds: async () => new Set<string>(LIVE_POSTING_TRADE_KINDS) };
    const service = new AdminCampusHeldRolesService(db as never, releases as never);
    expect(await service.held()).toEqual({
      roles: [
        {
          role_label: "Senior CNC Operator",
          count: 5,
          jobs: 3,
          students: 2,
          reason: "not_in_table",
        },
        { role_label: "Quality Engineer", count: 1, jobs: 1, students: 0, reason: "trade_switched_off" },
      ],
      courses: [{ course_label: "Spoken English", count: 2, reason: "not_in_table" }],
    });
  });
});

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "../admin/admin-roles.guard";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { AgencyJobsOpsController } from "./agency-jobs-ops.controller";
import { AgencyJobsAdminController } from "./agency-jobs-admin.controller";

/**
 * #2902 — `PUT /ops/agency-jobs/:jobId/match-skills` writes the same `jobs.match_skill_ids` as its
 * Admin Portal twin, so it must enforce the same capability: super_admin only. Before the fix it
 * mounted only InternalServiceGuard + AdminAuthGuard, so any signed-in admin (support, analyst)
 * forwarded with the internal secret could change which workers an agency job reaches.
 */

const GUARDS_METADATA = "__guards__";
const OTHER_ROLES: AdminRole[] = ["ops_admin", "support", "analyst"];
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "admin", role, sid: "sid" });
const prototype = AgencyJobsOpsController.prototype as unknown as Record<string, object>;

function context(who: AuthenticatedAdmin | undefined): ExecutionContext {
  const capability = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, prototype.setMatchSkills!);
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, capability, handler);
  return {
    getHandler: () => handler,
    getClass: () => AgencyJobsOpsController,
    switchToHttp: () => ({ getRequest: () => ({ admin: who }) }),
  } as unknown as ExecutionContext;
}

describe("AgencyJobsOpsController authorization (#2902)", () => {
  const guard = new AdminRolesGuard(new Reflector());

  it("declares the same capability as the Admin Portal twin", () => {
    const twin = AgencyJobsAdminController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, prototype.setMatchSkills!)).toBe(
      "manage_agency_match_skills",
    );
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, prototype.setMatchSkills!)).toBe(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, twin.set!),
    );
  });

  it("mounts the internal secret, the admin session and the role check, in that order", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AgencyJobsOpsController)).toEqual([
      InternalServiceGuard,
      AdminAuthGuard,
      AdminRolesGuard,
    ]);
  });

  it("lets super_admin through", () => {
    expect(guard.canActivate(context(admin("super_admin")))).toBe(true);
  });

  for (const role of OTHER_ROLES) {
    it(`refuses ${role}`, () => {
      expect(() => guard.canActivate(context(admin(role)))).toThrow(ForbiddenException);
    });
  }

  it("refuses a request with no admin session", () => {
    expect(() => guard.canActivate(context(undefined))).toThrow(UnauthorizedException);
  });
});

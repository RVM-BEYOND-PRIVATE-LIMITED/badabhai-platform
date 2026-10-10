import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "../admin/admin-roles.guard";
import { AgencyJobsAdminController } from "./agency-jobs-admin.controller";

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "admin", role, sid: "sid" });

function context(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const prototype = AgencyJobsAdminController.prototype as unknown as Record<string, object>;
  const capability = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, prototype[method]!);
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, capability, handler);
  return {
    getHandler: () => handler,
    getClass: () => AgencyJobsAdminController,
    switchToHttp: () => ({ getRequest: () => ({ admin: who }) }),
  } as unknown as ExecutionContext;
}

describe("AgencyJobsAdminController authorization", () => {
  const guard = new AdminRolesGuard(new Reflector());

  for (const method of ["list", "get", "set"]) {
    it(`${method} is super_admin-only and declares the dedicated capability`, () => {
      expect(guard.canActivate(context(method, admin("super_admin")))).toBe(true);
      expect(() => guard.canActivate(context(method, admin("ops_admin")))).toThrow(
        ForbiddenException,
      );
      expect(() => guard.canActivate(context(method, undefined))).toThrow(UnauthorizedException);
      const prototype = AgencyJobsAdminController.prototype as unknown as Record<string, object>;
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, prototype[method]!)).toBe(
        "manage_agency_match_skills",
      );
    });
  }
});

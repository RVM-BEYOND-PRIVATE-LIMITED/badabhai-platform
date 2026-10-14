import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "../admin/admin-roles.guard";
import type { MatchSkillsService } from "../match/match-skills.service";
import { AgencyMatchSkillsAdminController } from "./agency-match-skills-admin.controller";

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "admin", role, sid: "sid" });
const prototype = AgencyMatchSkillsAdminController.prototype as unknown as Record<string, object>;

function context(who: AuthenticatedAdmin | undefined): ExecutionContext {
  const capability = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, prototype.list!);
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, capability, handler);
  return {
    getHandler: () => handler,
    getClass: () => AgencyMatchSkillsAdminController,
    switchToHttp: () => ({ getRequest: () => ({ admin: who }) }),
  } as unknown as ExecutionContext;
}

describe("AgencyMatchSkillsAdminController (#2207)", () => {
  const guard = new AdminRolesGuard(new Reflector());

  it("mounts both admin guards at class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AgencyMatchSkillsAdminController) ??
      []) as unknown[];
    expect(guards).toEqual([AdminAuthGuard, AdminRolesGuard]);
  });

  it("declares the agency match-skill capability, so it is super_admin-only", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, prototype.list!)).toBe(
      "manage_agency_match_skills",
    );
    expect(guard.canActivate(context(admin("super_admin")))).toBe(true);
    for (const role of ["ops_admin", "support", "analyst"] as const) {
      expect(() => guard.canActivate(context(admin(role)))).toThrow(ForbiddenException);
    }
    expect(() => guard.canActivate(context(undefined))).toThrow(UnauthorizedException);
  });

  it("returns the service's vocabulary + cap unchanged", async () => {
    const body = { skills: [], max_skills_per_posting: 5 };
    const listVocabulary = vi.fn(async () => body);
    const controller = new AgencyMatchSkillsAdminController({
      listVocabulary,
    } as unknown as MatchSkillsService);
    await expect(controller.list()).resolves.toBe(body);
    expect(listVocabulary).toHaveBeenCalledOnce();
  });
});

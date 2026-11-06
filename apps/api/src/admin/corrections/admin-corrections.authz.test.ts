import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import type { AdminCapability } from "../admin-capabilities";
import { AdminCorrectionsController } from "./admin-corrections.controller";
import {
  AdminCorrectionCreateSchema,
  AdminCorrectionRevertSchema,
  correctionValueSchema,
} from "./admin-corrections.dto";

/**
 * #2561 — the correction routes: exactly one `edit_candidates` capability each, super_admin +
 * ops_admin + support allowed, analyst 403, no session 401, and every body `.strict()` with a
 * 15–500-character reason that rejects hard identifiers. The four LOCKED fields are accepted by
 * the schema only so the service can answer a named 400 (its own test).
 */

const ROUTES = ["correct", "revert", "history"] as const;
const proto = AdminCorrectionsController.prototype as unknown as Record<string, object>;
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
    getClass: () => AdminCorrectionsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const TEXT = "Worker called support and asked us to correct the city";

describe("#2561 correction routes — authz", () => {
  it("exposes exactly the three routes", () => {
    const methods = Object.getOwnPropertyNames(AdminCorrectionsController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard and declares edit_candidates per method", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminCorrectionsController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCorrectionsController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as AdminCapability).toBe(
        "edit_candidates",
      );
    }
  });

  it.each(ROUTES)("%s: super/ops/support allowed; analyst 403; no session 401", (route) => {
    for (const role of ["super_admin", "ops_admin", "support"] as AdminRole[]) {
      expect(guard.canActivate(ctxFor(route, admin(role)))).toBe(true);
    }
    expect(() => guard.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });
});

describe("#2561 correction contract", () => {
  it("canonicalises the city and de-duplicates a preferred-locations list", () => {
    const city = AdminCorrectionCreateSchema.parse({
      fact_key: "current_city",
      value: "pune",
      reason_code: "worker_request",
      reason_text: TEXT,
    });
    expect(city.value).toBe("pune");

    const list = correctionValueSchema("preferred_locations").parse([
      "Pune",
      "pune",
      "Nashik",
    ]);
    expect(list).toEqual(["Pune", "Nashik"]);
  });

  it("every body is .strict(); the reason is required and hard identifiers are rejected", () => {
    expect(
      AdminCorrectionCreateSchema.safeParse({
        fact_key: "current_city",
        value: "Pune",
        reason_code: "worker_request",
        reason_text: "short",
      }).success,
    ).toBe(false);
    expect(
      AdminCorrectionCreateSchema.safeParse({
        fact_key: "current_city",
        value: "Pune",
        reason_code: "worker_request",
        reason_text: "Call the worker on 9876543210 before changing this",
      }).success,
    ).toBe(false);
    expect(
      AdminCorrectionCreateSchema.safeParse({
        fact_key: "current_city",
        value: "Pune",
        reason_code: "worker_request",
        reason_text: TEXT,
        admin_id: "x",
      }).success,
    ).toBe(false);
    expect(
      AdminCorrectionRevertSchema.safeParse({
        reason_code: "other",
        reason_text: TEXT,
        worker_id: "x",
      }).success,
    ).toBe(false);
  });
});

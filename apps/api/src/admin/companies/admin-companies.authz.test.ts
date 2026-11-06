import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import type { AdminCapability } from "../admin-capabilities";
import { AdminCompaniesController } from "./admin-companies.controller";
import {
  AdminCompaniesQuerySchema,
  AdminCompanyReasonSchema,
  AdminCreateCompanySchema,
  AdminUpdateCompanySchema,
  GstinSchema,
} from "./admin-companies.dto";

/**
 * #2564 — the company-record routes: guarded, exactly ONE method-level capability each, and the
 * split that makes the surface safe: READS on the `read_entities` floor every role holds, WRITES
 * on `manage_companies` (super_admin + ops_admin). `support` can read a company but can never
 * edit, archive or restore one; `analyst` can read and nothing more.
 */

const READ_ROUTES = ["listCompanies", "getCompany"] as const;
const WRITE_ROUTES = [
  "createCompany",
  "updateCompany",
  "archiveCompany",
  "restoreCompany",
] as const;
const ROUTES = [...READ_ROUTES, ...WRITE_ROUTES] as const;
const proto = AdminCompaniesController.prototype as unknown as Record<string, object>;
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
    getClass: () => AdminCompaniesController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const TEXT = "Company asked us to fix its GSTIN and billing contact";

describe("#2564 company-record routes — authz", () => {
  it("exposes exactly the two reads and four writes", () => {
    const methods = Object.getOwnPropertyNames(AdminCompaniesController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminCompaniesController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("reads declare read_entities; writes declare manage_companies; none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCompaniesController)).toBeUndefined();
    for (const route of READ_ROUTES) {
      expect(
        Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as AdminCapability,
        route,
      ).toBe("read_entities");
    }
    for (const route of WRITE_ROUTES) {
      expect(
        Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as AdminCapability,
        route,
      ).toBe("manage_companies");
    }
  });

  it.each(READ_ROUTES)("%s: every role may read; no session 401", (route) => {
    for (const role of ["super_admin", "ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(guard.canActivate(ctxFor(route, admin(role)))).toBe(true);
    }
    expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });

  it.each(WRITE_ROUTES)(
    "%s: super_admin + ops_admin only; support/analyst 403; no session 401",
    (route) => {
      expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
      expect(guard.canActivate(ctxFor(route, admin("ops_admin")))).toBe(true);
      expect(() => guard.canActivate(ctxFor(route, admin("support")))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    },
  );
});

describe("#2564 company-record contract", () => {
  it("normalises a GSTIN before validating it, and rejects a bad one", () => {
    expect(GstinSchema.parse(" 27aapfu0939f1zv ")).toBe("27AAPFU0939F1ZV");
    expect(GstinSchema.safeParse("27AAPFU0939F1Z").success).toBe(false);
    expect(GstinSchema.safeParse("not-a-gstin").success).toBe(false);
  });

  it("every write body is .strict() and needs a written reason", () => {
    expect(
      AdminCompanyReasonSchema.safeParse({ reason_code: "inactive", reason_text: "too short" })
        .success,
    ).toBe(false);
    expect(
      AdminCompanyReasonSchema.safeParse({ reason_code: "inactive", reason_text: TEXT }).success,
    ).toBe(true);
    expect(
      AdminCompanyReasonSchema.safeParse({
        reason_code: "inactive",
        reason_text: TEXT,
        admin_id: "x",
      }).success,
    ).toBe(false);
  });

  it("the edit body refuses an empty change set and keeps the reason required", () => {
    expect(
      AdminUpdateCompanySchema.safeParse({
        reason_code: "inactive",
        reason_text: TEXT,
        changes: {},
      }).success,
    ).toBe(false);
    expect(
      AdminUpdateCompanySchema.safeParse({
        reason_code: "details_corrected",
        reason_text: TEXT,
        changes: { org_name: "Acme Works" },
      }).success,
    ).toBe(true);
  });

  it("create requires a first-login identifier and an org name", () => {
    const base = {
      kind: "employer",
      org_name: "Acme Works",
      reason_code: "client_request",
      reason_text: TEXT,
    };
    expect(AdminCreateCompanySchema.safeParse(base).success).toBe(false);
    expect(AdminCreateCompanySchema.safeParse({ ...base, email: "owner@acme.test" }).success).toBe(
      true,
    );
  });

  it("the list query clamps the page size to the identity bound (50)", () => {
    expect(AdminCompaniesQuerySchema.safeParse({ page_size: "500" }).success).toBe(false);
    expect(AdminCompaniesQuerySchema.parse({ page_size: "50" }).page_size).toBe(50);
    expect(AdminCompaniesQuerySchema.parse({}).page_size).toBe(25);
  });
});

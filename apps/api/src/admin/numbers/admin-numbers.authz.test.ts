import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import { ADMIN_CAPABILITY_MATRIX, can, type AdminCapability } from "../admin-capabilities";
import { AdminNumbersController } from "./admin-numbers.controller";
import {
  AdminNumbersMarkTestAccountSchema,
  AdminNumbersPayerParamsSchema,
  AdminNumbersWeeklyQuerySchema,
  NumbersIdempotencyKeySchema,
} from "./admin-numbers.dto";
import { AdminNumbersEnabledGuard, adminNumbersEnabled } from "./admin-numbers.flag";

/**
 * #2755 items 12 and 13 — every `/admin/numbers/*` route: guarded auth → switch → role, exactly ONE
 * method-level capability (`read_business_numbers`, super_admin + ops_admin), a neutral 404 for
 * every role while `ADMIN_NUMBERS_ENABLED` is off, a 403 for support and analyst once it is on, and
 * strict inputs on the marks.
 */

const ROUTES = ["definitions", "markTestAccount", "unmarkTestAccount", "weekly"] as const;
const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const proto = AdminNumbersController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const roles = new AdminRolesGuard(new Reflector());
const flag = (on: boolean | undefined) =>
  new AdminNumbersEnabledGuard({ ADMIN_NUMBERS_ENABLED: on } as never);

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
    getClass: () => AdminNumbersController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const PAYER = "11111111-1111-4111-8111-111111111111";

describe("#2755 numbers routes — guards and capability", () => {
  it("exposes exactly the definitions read, the two marks and the weekly read", () => {
    const methods = Object.getOwnPropertyNames(AdminNumbersController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard, then the switch, then AdminRolesGuard — in that order", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminNumbersController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([
      AdminAuthGuard.name,
      AdminNumbersEnabledGuard.name,
      AdminRolesGuard.name,
    ]);
  });

  it("every route declares read_business_numbers at the method level, and none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminNumbersController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(
        Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as AdminCapability,
        route,
      ).toBe("read_business_numbers");
    }
    // Owner question 1 default: super admin and ops admin ONLY.
    expect([...ADMIN_CAPABILITY_MATRIX.read_business_numbers].sort()).toEqual(
      ["ops_admin", "super_admin"].sort(),
    );
    // Not the read floor: support and analyst read entities and finance, never these numbers.
    expect(can("support", "read_entities")).toBe(true);
    expect(can("support", "read_business_numbers")).toBe(false);
    expect(can("analyst", "read_business_numbers")).toBe(false);
  });

  it.each(ROUTES)("%s: super_admin + ops_admin; support/analyst 403; no session 401", (route) => {
    expect(roles.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    expect(roles.canActivate(ctxFor(route, admin("ops_admin")))).toBe(true);
    expect(() => roles.canActivate(ctxFor(route, admin("support")))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });

  it("switch OFF: a neutral 404 for every role alike, before the role check could answer 403", () => {
    for (const role of ROLES) {
      expect(() => flag(false).canActivate(), role).toThrow(NotFoundException);
    }
    expect(() => flag(false).canActivate()).toThrow("Not Found");
    // Unset (an un-bridged config) is off too.
    expect(() => new AdminNumbersEnabledGuard({} as never).canActivate()).toThrow(
      NotFoundException,
    );
    expect(adminNumbersEnabled(undefined)).toBe(false);
    // It takes no role, session or request, so it cannot answer one caller differently.
    expect(AdminNumbersEnabledGuard.prototype.canActivate.length).toBe(0);
  });

  it("switch ON: the guard steps aside and the capability decides", () => {
    expect(flag(true).canActivate()).toBe(true);
    expect(adminNumbersEnabled({ ADMIN_NUMBERS_ENABLED: true })).toBe(true);
  });

  it("the routes are a GET, a PUT, a DELETE and a GET, all no-store", () => {
    const verbOf = (m: string) => Reflect.getMetadata("method", proto[m]!) as number;
    // Nest's RequestMethod: GET 0, PUT 2, DELETE 3.
    expect(verbOf("definitions")).toBe(0);
    expect(verbOf("markTestAccount")).toBe(2);
    expect(verbOf("unmarkTestAccount")).toBe(3);
    expect(verbOf("weekly")).toBe(0);
    expect(Reflect.getMetadata("path", proto.weekly!)).toBe("weekly");
    expect(Reflect.getMetadata("path", proto.definitions!)).toBe("definitions");
    expect(Reflect.getMetadata("path", proto.markTestAccount!)).toBe("test-accounts/:payerId");
    expect(Reflect.getMetadata("path", proto.unmarkTestAccount!)).toBe("test-accounts/:payerId");
    for (const m of ROUTES) {
      const headers = (Reflect.getMetadata("__headers__", proto[m]!) ?? []) as Array<{
        name: string;
        value: string;
      }>;
      expect(headers.find((h) => h.name.toLowerCase() === "cache-control")?.value, m).toBe(
        "no-store",
      );
    }
  });

  it("the PUT takes an Idempotency-Key parameter; the DELETE and the GET do not", () => {
    const argsOf = (m: string) =>
      Object.keys(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminNumbersController, m) ?? {}) as object,
      );
    const custom = (m: string) => argsOf(m).filter((k) => k.includes("__customRouteArgs__"));
    // @CurrentAdmin, @Ctx and the key are custom decorators: the PUT carries one more.
    expect(custom("markTestAccount").length).toBe(custom("unmarkTestAccount").length + 1);
    expect(argsOf("definitions")).toEqual([]);
    // The weekly read takes its query only: no admin, no context, no key — it writes nothing.
    expect(custom("weekly")).toEqual([]);
  });
});

describe("#2755 numbers routes — strict inputs", () => {
  it("the payer id must be a uuid and nothing else", () => {
    expect(AdminNumbersPayerParamsSchema.safeParse({ payerId: PAYER }).success).toBe(true);
    expect(AdminNumbersPayerParamsSchema.safeParse({ payerId: "acme" }).success).toBe(false);
    expect(AdminNumbersPayerParamsSchema.safeParse({ payerId: PAYER, x: 1 }).success).toBe(false);
  });

  it("the mark body is one closed reason code, strict", () => {
    for (const reason of ["synthetic_sign_in", "staff", "rehearsal", "pilot_test"]) {
      expect(AdminNumbersMarkTestAccountSchema.safeParse({ reason }).success, reason).toBe(true);
    }
    expect(AdminNumbersMarkTestAccountSchema.safeParse({}).success).toBe(false);
    expect(AdminNumbersMarkTestAccountSchema.safeParse({ reason: "because I said" }).success).toBe(
      false,
    );
    expect(
      AdminNumbersMarkTestAccountSchema.safeParse({ reason: "staff", note: "our own test" })
        .success,
    ).toBe(false);
  });

  it("the Idempotency-Key is 8..200 characters of the house charset", () => {
    expect(NumbersIdempotencyKeySchema.safeParse("mark-0001").success).toBe(true);
    expect(NumbersIdempotencyKeySchema.safeParse("a".repeat(200)).success).toBe(true);
    for (const bad of [undefined, "", "short", "a".repeat(201), "has space key", "émoji-key-1"]) {
      expect(NumbersIdempotencyKeySchema.safeParse(bad).success, String(bad)).toBe(false);
    }
    // The decorator's refusal is the house 400 shape.
    expect(new BadRequestException({ reason: "idempotency_key_required" }).getStatus()).toBe(400);
  });
});

describe("#2755 GET /admin/numbers/weekly — strict query (400 on anything else)", () => {
  const parse = (q: Record<string, unknown>) => AdminNumbersWeeklyQuerySchema.safeParse(q);

  it("defaults to all cities, all trades and 12 weeks", () => {
    expect(parse({})).toMatchObject({
      success: true,
      data: { city: "all", trade: "all", weeks: 12 },
    });
  });

  it("takes every group label of groups.ts, and the weeks 1..26 as a query string", () => {
    for (const city of ["all", "ncr", "pune", "ahmedabad", "other", "unknown"]) {
      expect(parse({ city }).success, city).toBe(true);
    }
    for (const trade of [
      "all",
      "cnc_operator",
      "cnc_cam_programmer",
      "sheet_metal",
      "cad_3d_designer",
      "other",
      "unknown",
    ]) {
      expect(parse({ trade }).success, trade).toBe(true);
    }
    expect(parse({ weeks: "1" })).toMatchObject({ success: true, data: { weeks: 1 } });
    expect(parse({ weeks: "26" })).toMatchObject({ success: true, data: { weeks: 26 } });
  });

  it("refuses an unknown group, a raw city, a week count out of range and an unknown key", () => {
    for (const bad of [
      { city: "mumbai" },
      { city: "Pune" },
      { city: "delhi" },
      { trade: "welder" },
      { trade: "cnc_turner" },
      { weeks: "0" },
      { weeks: "27" },
      { weeks: "2.5" },
      { weeks: "twelve" },
      { city: "all", sort: "desc" },
    ]) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

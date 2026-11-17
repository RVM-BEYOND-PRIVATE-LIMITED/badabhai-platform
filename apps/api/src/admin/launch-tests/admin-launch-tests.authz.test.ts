import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
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
import { ADMIN_IDENTITY_MAX_SUBJECTS } from "../admin-identity.service";
import { AdminNumbersEnabledGuard } from "../numbers/admin-numbers.flag";
import { AdminLaunchTestsController } from "./admin-launch-tests.controller";
import {
  AdminLaunchTestCohortQuerySchema,
  AdminLaunchTestParamsSchema,
  AdminLaunchTestRecordSchema,
  AdminLaunchTestUpdateSchema,
  LAUNCH_TEST_COHORT_PAGE_MAX,
} from "./admin-launch-tests.dto";

/**
 * #2755 part D — every `/admin/launch-tests/*` route: guarded auth → the numbers switch → role,
 * exactly ONE method-level capability (`read_business_numbers`, super_admin + ops_admin), a neutral
 * 404 for every role while `ADMIN_NUMBERS_ENABLED` is off, a 403 for support and analyst once it is
 * on, the Idempotency-Key on both writes, and strict inputs. The factory NAME's own gate
 * (`read_identity`) is the identity layer's and is pinned in the service suite.
 */

const ROUTES = ["listCohort", "recordFactory", "updateFactory", "contactsPerHire"] as const;
const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const proto = AdminLaunchTestsController.prototype as unknown as Record<string, object>;
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
    getClass: () => AdminLaunchTestsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const SENT = "2026-12-01T10:00:00+05:30";
const record = (over: Record<string, unknown> = {}) => ({
  factory_name: "Shree Precision Works",
  factory_phone: "+919876543210",
  city_group: "ncr",
  trade_group: "cnc_operator",
  sent_at: SENT,
  worker_ids: [W1, W2],
  ...over,
});

describe("#2755 part D launch-tests routes — guards and capability", () => {
  it("exposes exactly the cohort read, its two writes and the contacts-per-hire report", () => {
    const methods = Object.getOwnPropertyNames(AdminLaunchTestsController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard, then the numbers switch, then AdminRolesGuard — in that order", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminLaunchTestsController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([
      AdminAuthGuard.name,
      AdminNumbersEnabledGuard.name,
      AdminRolesGuard.name,
    ]);
  });

  it("every route declares read_business_numbers at the method level, and none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminLaunchTestsController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(
        Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as AdminCapability,
        route,
      ).toBe("read_business_numbers");
    }
    expect([...ADMIN_CAPABILITY_MATRIX.read_business_numbers].sort()).toEqual(
      ["ops_admin", "super_admin"].sort(),
    );
  });

  it.each(ROUTES)("%s: super_admin + ops_admin; support/analyst 403; no session 401", (route) => {
    expect(roles.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    expect(roles.canActivate(ctxFor(route, admin("ops_admin")))).toBe(true);
    expect(() => roles.canActivate(ctxFor(route, admin("support")))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });

  it("switch OFF: the same neutral 404 for every role, before the role check could answer 403", () => {
    for (const role of ROLES) {
      expect(() => flag(false).canActivate(), role).toThrow(NotFoundException);
    }
    expect(() => new AdminNumbersEnabledGuard({} as never).canActivate()).toThrow(
      NotFoundException,
    );
    expect(flag(true).canActivate()).toBe(true);
  });

  it("the factory name needs read_identity on top of the route capability (both route roles hold it)", () => {
    // The capability matrix the identity layer reads. A role with the route capability but no
    // read_identity sees the list faceless (the service suite pins the absent field).
    expect(can("super_admin", "read_identity")).toBe(true);
    expect(can("ops_admin", "read_identity")).toBe(true);
  });

  it("two GETs, a POST and a PATCH, on the documented paths, all no-store", () => {
    const verbOf = (m: string) => Reflect.getMetadata("method", proto[m]!) as number;
    // Nest's RequestMethod: GET 0, POST 1, PATCH 4.
    expect(verbOf("listCohort")).toBe(0);
    expect(verbOf("contactsPerHire")).toBe(0);
    expect(verbOf("recordFactory")).toBe(1);
    expect(verbOf("updateFactory")).toBe(4);
    expect(Reflect.getMetadata("path", AdminLaunchTestsController)).toBe("admin/launch-tests");
    expect(Reflect.getMetadata("path", proto.listCohort!)).toBe("cohort");
    expect(Reflect.getMetadata("path", proto.recordFactory!)).toBe("cohort");
    expect(Reflect.getMetadata("path", proto.updateFactory!)).toBe("cohort/:id");
    expect(Reflect.getMetadata("path", proto.contactsPerHire!)).toBe("contacts-per-hire");
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

  it("both writes take the Idempotency-Key parameter; the reads do not", () => {
    const custom = (m: string) =>
      Object.keys(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminLaunchTestsController, m) ?? {}) as object,
      ).filter((k) => k.includes("__customRouteArgs__"));
    // @CurrentAdmin and @Ctx are custom on the list; the writes add the key.
    expect(custom("listCohort")).toHaveLength(2);
    expect(custom("recordFactory")).toHaveLength(3);
    expect(custom("updateFactory")).toHaveLength(3);
    expect(custom("contactsPerHire")).toHaveLength(0);
  });
});

describe("#2755 part D launch-tests routes — strict inputs", () => {
  it("the record: name, groups, time and one to five distinct workers", () => {
    expect(AdminLaunchTestRecordSchema.safeParse(record()).success).toBe(true);
    // The phone is optional; the sent time carries an offset.
    expect(
      AdminLaunchTestRecordSchema.safeParse(record({ factory_phone: undefined })).success,
    ).toBe(true);
    const parsed = AdminLaunchTestRecordSchema.parse(record());
    expect(parsed.sent_at).toEqual(new Date("2026-12-01T04:30:00.000Z"));
    for (const [what, bad] of [
      ["no workers", record({ worker_ids: [] })],
      [
        "six workers",
        record({
          worker_ids: Array.from(
            { length: 6 },
            (_, i) => `00000000-0000-4000-8000-00000000000${i}`,
          ),
        }),
      ],
      ["a worker twice", record({ worker_ids: [W1, W1] })],
      ["a non-uuid worker", record({ worker_ids: ["ramesh"] })],
      ["the roll-up city", record({ city_group: "all" })],
      ["the unknown city", record({ city_group: "unknown" })],
      ["a raw city", record({ city_group: "Delhi" })],
      ["an unknown trade", record({ trade_group: "welder" })],
      ["a local phone", record({ factory_phone: "9876543210" })],
      ["a time with no offset", record({ sent_at: "2026-12-01 10:00" })],
      ["an empty name", record({ factory_name: "   " })],
      ["a name over 200", record({ factory_name: "a".repeat(201) })],
      ["a phone in the name", record({ factory_name: "Shree Works 9876543210" })],
      ["an email in the name", record({ factory_name: "owner@shree.example" })],
      ["a control character in the name", record({ factory_name: "Shree\tWorks" })],
      ["an unknown field", record({ note: "called twice" })],
      ["a result on create", record({ result: "paid" })],
      ["a link with a space", record({ payment_link_ref: "rzp link 1" })],
      ["a link over 300", record({ payment_link_ref: "x".repeat(301) })],
    ] as const) {
      expect(AdminLaunchTestRecordSchema.safeParse(bad).success, what).toBe(false);
    }
    // Every launch group and `other` is accepted.
    for (const city_group of ["ncr", "pune", "ahmedabad", "other"]) {
      expect(
        AdminLaunchTestRecordSchema.safeParse(record({ city_group })).success,
        city_group,
      ).toBe(true);
    }
    expect(
      AdminLaunchTestRecordSchema.safeParse(record({ payment_link_ref: "https://rzp.io/l/AbC123" }))
        .success,
    ).toBe(true);
  });

  it("the edit: any of six fields, at least one; null clears; closed results", () => {
    expect(AdminLaunchTestUpdateSchema.safeParse({ result: "declined" }).success).toBe(true);
    expect(
      AdminLaunchTestUpdateSchema.safeParse({ result: "paid", paid_at: "2026-12-03T10:00:00Z" })
        .success,
    ).toBe(true);
    expect(
      AdminLaunchTestUpdateSchema.safeParse({ payment_link_ref: null, link_created_at: null })
        .success,
    ).toBe(true);
    expect(AdminLaunchTestUpdateSchema.safeParse({}).success).toBe(false);
    expect(AdminLaunchTestUpdateSchema.safeParse({ result: "refunded" }).success).toBe(false);
    expect(AdminLaunchTestUpdateSchema.safeParse({ result: null }).success).toBe(false);
    expect(AdminLaunchTestUpdateSchema.safeParse({ factory_name: "Renamed" }).success).toBe(false);
    expect(AdminLaunchTestUpdateSchema.safeParse({ worker_ids: [W1] }).success).toBe(false);
    expect(AdminLaunchTestUpdateSchema.safeParse({ payment_order_id: "order_1" }).success).toBe(
      false,
    );
    expect(AdminLaunchTestParamsSchema.safeParse({ id: W1 }).success).toBe(true);
    expect(AdminLaunchTestParamsSchema.safeParse({ id: "1" }).success).toBe(false);
  });

  it("the list page is at most the identity layer's bound, so a named page is always whole", () => {
    expect(LAUNCH_TEST_COHORT_PAGE_MAX).toBe(ADMIN_IDENTITY_MAX_SUBJECTS);
    expect(AdminLaunchTestCohortQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(AdminLaunchTestCohortQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(AdminLaunchTestCohortQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(AdminLaunchTestCohortQuerySchema.safeParse({ city: "ncr" }).success).toBe(false);
  });
});

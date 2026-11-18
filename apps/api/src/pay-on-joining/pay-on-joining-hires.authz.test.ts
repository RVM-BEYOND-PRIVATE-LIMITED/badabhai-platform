import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { POJ_HIRE_FIELDS } from "@badabhai/event-schema";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin/admin-roles.guard";
import { ADMIN_CAPABILITY_MATRIX, type AdminCapability } from "../admin/admin-capabilities";
import {
  CreatePojHireSchema,
  ListPojHiresQuerySchema,
  PojHireParamsSchema,
  UpdatePojHireSchema,
} from "./pay-on-joining-hires.dto";
import { PayOnJoiningHiresController } from "./pay-on-joining-hires.controller";
import { PayOnJoiningFlagGuard } from "./pay-on-joining.flag.guard";

/**
 * #2753 item 11 — the hire-record routes: guarded in the order auth → switch → role, exactly ONE
 * method-level capability each (`manage_companies`, super_admin + ops_admin), a neutral 404 for
 * every role while the switch is off, and `.strict()` bodies that refuse a client-sent share.
 */

const ROUTES = ["listHires", "createHire", "updateHire"] as const;
const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const proto = PayOnJoiningHiresController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const roles = new AdminRolesGuard(new Reflector());
const flag = (on: boolean) =>
  new PayOnJoiningFlagGuard({ PAY_ON_JOINING_RECORDS_ENABLED: on } as never);

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
    getClass: () => PayOnJoiningHiresController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const UUID = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const CREATE = {
  factory_payer_id: UUID(1),
  worker_id: UUID(2),
  joined_on: "2026-12-01",
  fee_paise: 500_000,
};

describe("#2753 item 11 hire-record routes — guards and capability", () => {
  it("exposes exactly the list, the create and the edit", () => {
    const methods = Object.getOwnPropertyNames(PayOnJoiningHiresController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard, then the switch, then AdminRolesGuard — in that order", () => {
    const guards = (Reflect.getMetadata("__guards__", PayOnJoiningHiresController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([
      AdminAuthGuard.name,
      PayOnJoiningFlagGuard.name,
      AdminRolesGuard.name,
    ]);
  });

  it("every route declares manage_companies at the method level, and none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, PayOnJoiningHiresController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(
        Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as AdminCapability,
        route,
      ).toBe("manage_companies");
    }
    // The reused row is exactly the brief's default allow-set; this route does not widen it.
    expect([...ADMIN_CAPABILITY_MATRIX.manage_companies].sort()).toEqual(
      ["ops_admin", "super_admin"].sort(),
    );
  });

  it.each(ROUTES)(
    "%s: super_admin + ops_admin only; support/analyst 403; no session 401",
    (route) => {
      expect(roles.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
      expect(roles.canActivate(ctxFor(route, admin("ops_admin")))).toBe(true);
      expect(() => roles.canActivate(ctxFor(route, admin("support")))).toThrow(ForbiddenException);
      expect(() => roles.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
      expect(() => roles.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    },
  );

  it("switch OFF: a neutral 404 for every role alike, before the role check could answer 403", () => {
    // The flag guard runs before AdminRolesGuard, so support and analyst get the same 404 as a
    // super admin: nothing tells a lesser role the route exists.
    for (const role of ROLES) {
      expect(() => flag(false).canActivate(), role).toThrow(NotFoundException);
    }
    expect(() => flag(false).canActivate()).toThrow("Not found");
    // Unset (an un-bridged config) is off too.
    expect(() => new PayOnJoiningFlagGuard({} as never).canActivate()).toThrow(NotFoundException);
    // It takes no role, session or request, so it cannot answer one caller differently.
    expect(PayOnJoiningFlagGuard.prototype.canActivate.length).toBe(0);
  });

  it("switch ON: the guard steps aside and the capability decides", () => {
    expect(flag(true).canActivate()).toBe(true);
  });
});

describe("#2753 item 11 hire-record contract — strict bodies", () => {
  it("create takes the factory, the worker, the joining date and the fee", () => {
    expect(CreatePojHireSchema.safeParse(CREATE).success).toBe(true);
    for (const key of Object.keys(CREATE)) {
      const { [key]: _gone, ...without } = CREATE as Record<string, unknown>;
      expect(CreatePojHireSchema.safeParse(without).success, key).toBe(false);
    }
  });

  it("a client-sent share or percent is REFUSED, never ignored", () => {
    for (const smuggled of [
      { partner_share_paise: 350_000 },
      { partner_share_percent: 70 },
      { created_by_admin_id: UUID(3) },
      { payment_state: "settled" },
    ]) {
      expect(CreatePojHireSchema.safeParse({ ...CREATE, ...smuggled }).success).toBe(false);
      expect(UpdatePojHireSchema.safeParse(smuggled).success).toBe(false);
    }
  });

  it("money is whole, non-negative, safe paise", () => {
    for (const fee of [-1, 100.5, Number.MAX_SAFE_INTEGER + 2, "500000"]) {
      expect(
        CreatePojHireSchema.safeParse({ ...CREATE, fee_paise: fee }).success,
        String(fee),
      ).toBe(false);
    }
    expect(CreatePojHireSchema.safeParse({ ...CREATE, fee_paise: 0 }).success).toBe(true);
    expect(
      CreatePojHireSchema.safeParse({ ...CREATE, fee_paise: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
  });

  it("dates are real calendar days", () => {
    for (const joined_on of [
      "2026-02-30",
      "2026-13-01",
      "01-12-2026",
      "2026-12-01T00:00:00Z",
      "",
    ]) {
      expect(CreatePojHireSchema.safeParse({ ...CREATE, joined_on }).success, joined_on).toBe(
        false,
      );
    }
    expect(CreatePojHireSchema.safeParse({ ...CREATE, joined_on: "2028-02-29" }).success).toBe(
      true,
    );
  });

  it("the note is capped at 500, and refuses a phone or an email", () => {
    expect(CreatePojHireSchema.safeParse({ ...CREATE, note: "x".repeat(500) }).success).toBe(true);
    expect(CreatePojHireSchema.safeParse({ ...CREATE, note: "x".repeat(501) }).success).toBe(false);
    expect(
      CreatePojHireSchema.safeParse({ ...CREATE, note: "Call him on 9876543210" }).success,
    ).toBe(false);
    expect(
      CreatePojHireSchema.safeParse({ ...CREATE, note: "Mail hr@factory.example about it" })
        .success,
    ).toBe(false);
    expect(CreatePojHireSchema.safeParse({ ...CREATE, note: "   " }).success).toBe(false);
  });

  it("the edit takes any field, at least one, and cannot clear the four required ones", () => {
    expect(UpdatePojHireSchema.safeParse({}).success).toBe(false);
    expect(UpdatePojHireSchema.safeParse({ factory_paid_on: "2027-01-05" }).success).toBe(true);
    expect(UpdatePojHireSchema.safeParse({ note: null, partner_payer_id: null }).success).toBe(
      true,
    );
    for (const key of ["factory_payer_id", "worker_id", "joined_on", "fee_paise"]) {
      expect(UpdatePojHireSchema.safeParse({ [key]: null }).success, key).toBe(false);
    }
    // Every field key on the event is a field the edit accepts, and nothing else is.
    for (const key of POJ_HIRE_FIELDS) {
      expect(UpdatePojHireSchema.shape, key).toHaveProperty(key);
    }
    expect(Object.keys(UpdatePojHireSchema.shape).sort()).toEqual([...POJ_HIRE_FIELDS].sort());
  });

  it("the list filters by factory, partner and paid state, with the entity page bounds", () => {
    expect(ListPojHiresQuerySchema.parse({}).limit).toBe(50);
    expect(ListPojHiresQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    for (const paid of ["awaiting_factory", "partner_due", "settled"]) {
      expect(ListPojHiresQuerySchema.safeParse({ paid }).success, paid).toBe(true);
    }
    expect(ListPojHiresQuerySchema.safeParse({ paid: "paid" }).success).toBe(false);
    expect(ListPojHiresQuerySchema.safeParse({ factory_payer_id: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(ListPojHiresQuerySchema.safeParse({ worker_id: UUID(2) }).success).toBe(false);
    expect(PojHireParamsSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});

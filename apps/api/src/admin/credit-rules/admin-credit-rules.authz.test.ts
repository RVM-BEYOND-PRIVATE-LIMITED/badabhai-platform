import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import { AdminCreditRulesController } from "./admin-credit-rules.controller";
import { AdminUpdateCreditRulesSchema } from "./admin-credit-rules.dto";

/**
 * #2750 item 1 / item 12 — the credit rules' settings routes: guarded, ONE method-level capability
 * each (`manage_credit_rules`, super_admin only: an edit changes every company's price at once),
 * 404 while the switch is off everywhere, and an edit body that cannot reset a rule by omission.
 */

const ROUTES = ["getCreditRules", "updateCreditRules"] as const;
const proto = AdminCreditRulesController.prototype as unknown as Record<string, object>;
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
    getClass: () => AdminCreditRulesController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const REASON = "Pilot companies asked for the brief's starting values";

describe("#2750 credit-rules routes — authz", () => {
  it("exposes exactly the read and the edit", () => {
    const methods = Object.getOwnPropertyNames(AdminCreditRulesController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminCreditRulesController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("both routes declare manage_credit_rules; none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCreditRulesController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!), route).toBe(
        "manage_credit_rules",
      );
    }
  });

  it.each(ROUTES)("%s: super_admin only; every other role 403; no session 401", (route) => {
    expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() => guard.canActivate(ctxFor(route, admin(role))), role).toThrow(ForbiddenException);
    }
    expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });
});

describe("#2750 credit-rules routes — the switch", () => {
  function controller(live: boolean) {
    const service = {
      assertLive: vi.fn(() => {
        if (!live) throw new NotFoundException();
      }),
      readForAdmin: vi.fn(async () => ({
        rules: DEFAULT_CREDIT_RULES,
        revision: 0,
        source: "default" as const,
        updatedAt: null,
      })),
      update: vi.fn(),
    };
    return { service, controller: new AdminCreditRulesController(service as never) };
  }

  it("off everywhere: both routes 404 and the table is never read or written", async () => {
    const { service, controller: c } = controller(false);
    await expect(c.getCreditRules()).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      c.updateCreditRules(
        admin("super_admin"),
        { rules: DEFAULT_CREDIT_RULES, expected_revision: 0, reason_text: REASON },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.readForAdmin).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("on: the read returns the rules, the brief's defaults and the revision to edit", async () => {
    const { controller: c } = controller(true);
    expect(await c.getCreditRules()).toEqual({
      rules: DEFAULT_CREDIT_RULES,
      defaults: DEFAULT_CREDIT_RULES,
      revision: 0,
      source: "default",
      updated_at: null,
    });
  });

  it("the edit's actor is the session admin, never a body field", async () => {
    const { service, controller: c } = controller(true);
    service.update.mockResolvedValue({
      rules: DEFAULT_CREDIT_RULES,
      revision: 1,
      source: "db",
      updatedAt: new Date("2026-11-17T08:00:00Z"),
      changed: true,
      changedKeys: ["higherCost"],
    });
    const out = await c.updateCreditRules(
      { id: "session-admin", role: "super_admin", sid: "s" },
      { rules: DEFAULT_CREDIT_RULES, expected_revision: 0, reason_text: REASON },
      {} as never,
    );
    expect(service.update.mock.calls[0]![0]).toBe("session-admin");
    expect(out.changed_keys).toEqual(["higherCost"]);
    expect(out.updated_at).toBe("2026-11-17T08:00:00.000Z");
  });
});

describe("#2750 credit-rules edit body", () => {
  const valid = { rules: DEFAULT_CREDIT_RULES, expected_revision: 0, reason_text: REASON };

  it("accepts every rule, the revision and a reason", () => {
    expect(AdminUpdateCreditRulesSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses a partial rule set (a missing key is never reset to its default)", () => {
    const { welcomeCredits: _dropped, ...partial } = DEFAULT_CREDIT_RULES;
    expect(AdminUpdateCreditRulesSchema.safeParse({ ...valid, rules: partial }).success).toBe(
      false,
    );
  });

  it("refuses an unknown key at either level, including an admin id", () => {
    expect(AdminUpdateCreditRulesSchema.safeParse({ ...valid, admin_id: "x" }).success).toBe(false);
    expect(
      AdminUpdateCreditRulesSchema.safeParse({
        ...valid,
        rules: { ...DEFAULT_CREDIT_RULES, freeUnlockCredits: 50 },
      }).success,
    ).toBe(false);
  });

  it("needs a written reason, and refuses one carrying a phone number", () => {
    expect(AdminUpdateCreditRulesSchema.safeParse({ ...valid, reason_text: "short" }).success).toBe(
      false,
    );
    expect(
      AdminUpdateCreditRulesSchema.safeParse({
        ...valid,
        reason_text: "Changed after a call with 9876543210 today",
      }).success,
    ).toBe(false);
  });

  it("refuses a negative or fractional expected_revision", () => {
    expect(
      AdminUpdateCreditRulesSchema.safeParse({ ...valid, expected_revision: -1 }).success,
    ).toBe(false);
    expect(
      AdminUpdateCreditRulesSchema.safeParse({ ...valid, expected_revision: 1.5 }).success,
    ).toBe(false);
  });
});

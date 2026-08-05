import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminActionsController } from "./admin-actions.controller";

/**
 * Per-ROLE authz for the BP-2 finance reads.
 *
 * The property that matters: SEEING a balance and CHANGING one are different privileges.
 * `GET /admin/finance/*` is `read_entities` (all four roles); `POST /admin/payers/:id/credits`
 * is `grant_credits` (super_admin + ops_admin). Collapsing them would mean an analyst
 * investigating a billing complaint needs the ability to alter the balance they are querying.
 */

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

function declaredCapability(
  ctor: new (...a: never[]) => object,
  method: string,
): AdminCapability {
  const proto = ctor.prototype as unknown as Record<string, object>;
  const cap =
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as AdminCapability | undefined) ??
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, ctor) as AdminCapability | undefined);
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

function ctxFor(
  ctor: new (...a: never[]) => object,
  method: string,
  who: AuthenticatedAdmin | undefined,
): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declaredCapability(ctor, method), handler);
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());
const ROUTES = ["summary", "ledger", "orders"] as const;

describe("BP-2 authz — finance reads are the read floor", () => {
  for (const route of ROUTES) {
    it(`${route}: ALL four roles pass`, () => {
      for (const role of ROLES) {
        expect(guard.canActivate(ctxFor(AdminFinanceController, route, admin(role)))).toBe(true);
      }
    });

    it(`${route}: unauthenticated → 401`, () => {
      expect(() => guard.canActivate(ctxFor(AdminFinanceController, route, undefined))).toThrow(
        UnauthorizedException,
      );
    });

    it(`${route}: an unknown role is DENIED (deny-by-default)`, () => {
      const rogue = { id: "a", role: "treasurer" as AdminRole, sid: "s" };
      expect(() => guard.canActivate(ctxFor(AdminFinanceController, route, rogue))).toThrow(
        ForbiddenException,
      );
    });

    it(`${route} declares read_entities`, () => {
      expect(declaredCapability(AdminFinanceController, route)).toBe("read_entities");
    });
  }
});

describe("BP-2 — reading money never confers moving it", () => {
  it("analyst may read the ledger but is DENIED granting credits", () => {
    expect(guard.canActivate(ctxFor(AdminFinanceController, "ledger", admin("analyst")))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(ctxFor(AdminActionsController, "grantCredits", admin("analyst"))),
    ).toThrow(ForbiddenException);
  });

  it("support may read every finance route but may not grant credits", () => {
    for (const route of ROUTES) {
      expect(guard.canActivate(ctxFor(AdminFinanceController, route, admin("support")))).toBe(
        true,
      );
    }
    expect(() =>
      guard.canActivate(ctxFor(AdminActionsController, "grantCredits", admin("support"))),
    ).toThrow(ForbiddenException);
  });

  it("the read and the write declare DIFFERENT capabilities", () => {
    expect(declaredCapability(AdminFinanceController, "summary")).not.toBe(
      declaredCapability(AdminActionsController, "grantCredits"),
    );
    expect(declaredCapability(AdminActionsController, "grantCredits")).toBe("grant_credits");
  });
});

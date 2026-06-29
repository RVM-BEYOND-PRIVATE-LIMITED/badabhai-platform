import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";

/**
 * Per-ROLE authz for the ADMIN-3b PII-reveal route (ADR-0025 Decision 4). Drives the REAL
 * {@link AdminRolesGuard} with the route's REAL declared @RequireAdminRole("reveal_pii"):
 *   - reveal_pii → super_admin + support ALLOWED; ops_admin + analyst DENIED (403);
 *   - an unauthenticated request (no req.admin) → 401 (fail closed).
 * This is Control: "role gate (support+super only; ops_admin/analyst → 403)".
 */

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

function declaredCapability(method: string): AdminCapability {
  const proto = AdminPiiRevealController.prototype as unknown as Record<string, object>;
  const cap =
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as AdminCapability | undefined) ??
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminPiiRevealController) as
      | AdminCapability
      | undefined);
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

function ctxFor(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declaredCapability(method), handler);
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminPiiRevealController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());

describe("ADMIN-3b authz — reveal-contact is reveal_pii (super_admin + support ONLY)", () => {
  it("declares exactly the reveal_pii capability", () => {
    expect(declaredCapability("revealContact")).toBe("reveal_pii");
  });

  it("super_admin + support ALLOWED", () => {
    for (const role of ["super_admin", "support"] as AdminRole[]) {
      expect(guard.canActivate(ctxFor("revealContact", admin(role)))).toBe(true);
    }
  });

  it("ops_admin + analyst DENIED (403) — the reveal role is least-privilege", () => {
    for (const role of ["ops_admin", "analyst"] as AdminRole[]) {
      expect(() => guard.canActivate(ctxFor("revealContact", admin(role)))).toThrow(
        ForbiddenException,
      );
    }
  });

  it("unauthenticated (no req.admin) → 401 (fail closed)", () => {
    expect(() => guard.canActivate(ctxFor("revealContact", undefined))).toThrow(
      UnauthorizedException,
    );
  });
});

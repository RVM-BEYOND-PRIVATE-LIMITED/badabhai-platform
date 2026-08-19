import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { ADMIN_CAPABILITY_MATRIX, type AdminCapability } from "./admin-capabilities";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminEventsController } from "./admin-events.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";
import { AdminKillSwitchController } from "./admin-kill-switch.controller";

/**
 * Per-ROLE authz for the BP-5 dashboard summary.
 *
 * THE CAPABILITY IS `read_entities`, chosen by the DATA the route exposes. One block
 * (`cap_breaches`) reads the event spine; everything else is live system-of-record state plus
 * money out of `platform_ai_cost_totals`. That is what `read_entities` is documented to mean,
 * and it is the capability the closest neighbour — `AdminFinanceController`, also an aggregate
 * over money tables — already declares. Pinned to that neighbour below rather than to
 * `GET /admin/events/metrics`: the two capabilities have IDENTICAL allow-sets today, so this is
 * not a privilege change, and the pin has to be to the route that shares this one's MEANING or
 * it re-encodes the mistake it is meant to prevent.
 *
 * And the separations that must HOLD: reading how much AI cost never confers turning AI off
 * (`toggle_kill_switch`, super_admin), and reading platform-wide counts never confers seeing
 * one worker's phone number (`reveal_pii`, super_admin + support).
 */

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

function declaredCapability(ctor: new (...a: never[]) => object, method: string): AdminCapability {
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

describe("BP-5 authz — the dashboard summary is the read floor", () => {
  it("ALL four roles may read it", () => {
    for (const role of ROLES) {
      expect(guard.canActivate(ctxFor(AdminDashboardController, "summary", admin(role)))).toBe(
        true,
      );
    }
  });

  it("unauthenticated → 401", () => {
    expect(() => guard.canActivate(ctxFor(AdminDashboardController, "summary", undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it("an unknown role is DENIED (deny-by-default, never defaulted to a privileged role)", () => {
    const rogue = { id: "a", role: "cfo" as AdminRole, sid: "s" };
    expect(() => guard.canActivate(ctxFor(AdminDashboardController, "summary", rogue))).toThrow(
      ForbiddenException,
    );
  });

  it("declares `read_entities` — the SAME capability as the finance aggregates", () => {
    expect(declaredCapability(AdminDashboardController, "summary")).toBe("read_entities");
    // Pinned to the neighbour that shares this route's MEANING: `GET /admin/finance/summary` is
    // also an aggregate over money tables and also not a per-row projection. If that route's
    // capability ever moves, this one is asking to move with it.
    expect(declaredCapability(AdminDashboardController, "summary")).toBe(
      declaredCapability(AdminFinanceController, "summary"),
    );
  });

  it("the two read capabilities have IDENTICAL allow-sets today — so this is a NAME, not a grant", () => {
    // The whole reason the choice is arguable is that nothing observable changes: every role
    // allowed `read_events` is allowed `read_entities`. The day that stops being true, this
    // assertion fails and somebody has to decide which side the dashboard belongs on — which is
    // the entire point of naming it by meaning now.
    expect([...ADMIN_CAPABILITY_MATRIX.read_entities].sort()).toEqual(
      [...ADMIN_CAPABILITY_MATRIX.read_events].sort(),
    );
    // …and the events strip this dashboard sits beside is still `read_events`, unchanged.
    expect(declaredCapability(AdminEventsController, "metrics")).toBe("read_events");
  });

  it("mints NO new capability (an ADR-0025 matrix row is not this PR's to add)", () => {
    const existing: AdminCapability[] = [
      "read_events",
      "read_entities",
      "export",
      "suspend_payer",
      "grant_credits",
      "force_close_posting",
      "flag_worker",
      "toggle_kill_switch",
      "reveal_pii",
      "manage_admins",
    ];
    expect(existing).toContain(declaredCapability(AdminDashboardController, "summary"));
  });
});

describe("BP-5 — reading the numbers confers nothing else", () => {
  it("an analyst may read the AI spend but may NOT touch the kill switch", () => {
    expect(guard.canActivate(ctxFor(AdminDashboardController, "summary", admin("analyst")))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(ctxFor(AdminKillSwitchController, "status", admin("analyst"))),
    ).toThrow(ForbiddenException);
  });

  it("an ops_admin may read platform-wide counts but may NOT reveal one worker's contact", () => {
    expect(guard.canActivate(ctxFor(AdminDashboardController, "summary", admin("ops_admin")))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin("ops_admin"))),
    ).toThrow(ForbiddenException);
  });

  it("an analyst may read the dashboard but may NOT grant credits", () => {
    expect(() =>
      guard.canActivate(ctxFor(AdminActionsController, "grantCredits", admin("analyst"))),
    ).toThrow(ForbiddenException);
  });
});

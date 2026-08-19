import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminEventsController } from "./admin-events.controller";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";
import { AdminKillSwitchController } from "./admin-kill-switch.controller";

/**
 * Per-ROLE authz for the BP-5 dashboard summary.
 *
 * The property that matters: this route sits at the SAME tier as the dashboard strip it
 * extends. `GET /admin/dashboard/summary` and `GET /admin/events/metrics` are one screen, so
 * they declare one capability — `read_events`, all four roles. If they ever diverge, half the
 * dashboard 403s for a role that can see the other half, which is worse than either answer.
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

  it("declares `read_events` — the SAME capability as GET /admin/events/metrics", () => {
    expect(declaredCapability(AdminDashboardController, "summary")).toBe("read_events");
    // Pinned to the neighbouring route rather than to the literal, so the two cannot drift:
    // they are one screen, and a divergence 403s half of it for somebody.
    expect(declaredCapability(AdminDashboardController, "summary")).toBe(
      declaredCapability(AdminEventsController, "metrics"),
    );
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

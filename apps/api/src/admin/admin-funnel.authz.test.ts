import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import type { AdminCapability } from "./admin-capabilities";
import { AdminFunnelController } from "./admin-funnel.controller";

/**
 * Per-role authz matrix for the B14 onboarding-funnel read, driving the REAL
 * {@link AdminRolesGuard} with the route's REAL declared capability.
 *
 * ── THE RBAC DECISION THIS PINS ────────────────────────────────────────────────────
 * The funnel reads sit on `read_entities`, the existing read floor — the same call the
 * dashboard and the per-worker journey make, for the same reason: aggregates over
 * platform state, no subject pivot, k-anon'd split cells. What matters here is that
 * the decision is ASSERTED rather than assumed, in three directions:
 *
 *   - all four roles hold it (it is the read floor);
 *   - an analyst who can see that 40 workers stopped at profiling cannot flag one;
 *   - and it does NOT confer `reveal_pii` or any write: a funnel is not a door into
 *     a worker's record.
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

describe("B14 authz matrix — the funnel read sits on the `read_entities` floor", () => {
  it("onboarding: ALL four roles pass", () => {
    for (const role of ROLES) {
      expect(guard.canActivate(ctxFor(AdminFunnelController, "onboarding", admin(role)))).toBe(
        true,
      );
    }
  });

  it("onboarding: unauthenticated → 401 (fail closed, never a silent allow)", () => {
    expect(() => guard.canActivate(ctxFor(AdminFunnelController, "onboarding", undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it("onboarding: an unknown role is DENIED (deny-by-default, never defaulted to privileged)", () => {
    const rogue = { id: "a", role: "root" as AdminRole, sid: "s" };
    expect(() => guard.canActivate(ctxFor(AdminFunnelController, "onboarding", rogue))).toThrow(
      ForbiddenException,
    );
  });

  it("reading the funnel confers no moderation, grant, reveal or review power", () => {
    // The route's ONE capability must not be smuggled into a second one: an analyst who
    // can read where the base drops out must not be able to act on any worker in it.
    for (const cap of [
      "suspend_payer",
      "grant_credits",
      "force_close_posting",
      "flag_worker",
      "reveal_pii",
      "manage_admins",
      "review_skill_candidates",
    ] as const) {
      expect(declaredCapability(AdminFunnelController, "onboarding")).not.toBe(cap);
    }
  });
});

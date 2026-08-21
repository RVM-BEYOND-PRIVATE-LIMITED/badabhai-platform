import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { ADMIN_CAPABILITIES, type AdminCapability } from "./admin-capabilities";
import { AdminFeedbackController } from "./admin-feedback.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";

/**
 * Per-ROLE authz for `GET /admin/feedback` (#997), driving the REAL {@link AdminRolesGuard}
 * with the route's REAL declared capability.
 *
 * ── WHAT THIS FILE IS ACTUALLY DEFENDING ────────────────────────────────────────────────
 * This is the one admin read that returns worker-authored free text, so "who may call it" is
 * a sharper question here than on the faceless lists. Three separate properties, and the
 * first is the one that would be easy to get wrong by accident:
 *
 *   1. A principal WITHOUT `read_entities` is refused. All four defined roles hold it (it is
 *      the ADR-0025 read floor), so the only way to exercise the refusal is an UNKNOWN role —
 *      which is also the realistic failure: a role string arriving from a stale token, a typo
 *      in a seed, or a future role added to the enum and forgotten in the matrix. `can()` is
 *      deny-by-default, and that is asserted here rather than assumed.
 *   2. An unauthenticated caller is refused with a 401, never a silent allow.
 *   3. Reading feedback is NOT reading identity. `read_entities` must stay strictly weaker
 *      than `reveal_pii`: an analyst who can see "my supervisor takes my wages" must not
 *      thereby be able to resolve whose phone number that is.
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

/** An ExecutionContext whose handler carries the route's REAL declared capability. */
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

describe("#997 GET /admin/feedback — who may read a worker's own words", () => {
  it("declares read_entities — an EXISTING capability, not a newly minted one", () => {
    // Minting a capability for this route would break `capabilities.test.ts`, which pins the
    // portal's ten-string vocabulary as a literal — by design, because a new capability is a
    // product decision about who may read feedback, and nobody has made one (CLAUDE.md §16).
    expect(declaredCapability(AdminFeedbackController, "list")).toBe("read_entities");
    expect(ADMIN_CAPABILITIES).toContain("read_entities");
  });

  it("ALL four defined roles pass — read_entities is the ADR-0025 read floor", () => {
    for (const role of ROLES) {
      expect(guard.canActivate(ctxFor(AdminFeedbackController, "list", admin(role)))).toBe(true);
    }
  });

  it("a principal whose role does NOT hold read_entities is refused (deny-by-default)", () => {
    // The realistic shape of "lacks the capability" on this surface: a role the matrix has
    // never heard of. `can()` denies it rather than defaulting to a privileged role, so an
    // enum widened without a matrix row fails closed instead of opening this read.
    for (const rogue of ["root", "viewer", "", "read_entities"]) {
      const who = { id: "a", role: rogue as AdminRole, sid: "s" };
      expect(() => guard.canActivate(ctxFor(AdminFeedbackController, "list", who))).toThrow(
        ForbiddenException,
      );
    }
  });

  it("unauthenticated → 401 (fail closed, never a silent allow)", () => {
    expect(() => guard.canActivate(ctxFor(AdminFeedbackController, "list", undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it("a null role is refused, not treated as an absent filter", () => {
    const who = { id: "a", role: null as unknown as AdminRole, sid: "s" };
    expect(() => guard.canActivate(ctxFor(AdminFeedbackController, "list", who))).toThrow(
      ForbiddenException,
    );
  });
});

describe("#997 — reading feedback NEVER confers resolving who wrote it", () => {
  /**
   * The separation that makes projecting `message` acceptable at all. The feedback row carries
   * an opaque `worker_id`; turning that into a phone number is `POST /admin/workers/:id/
   * reveal-contact`, a different route, a different capability, a default-off flag, a reason
   * code and an audit-before-decrypt. If those two ever collapsed onto one capability, this
   * screen would silently become an identity-resolution surface.
   */
  it("the two routes declare DIFFERENT capabilities", () => {
    expect(declaredCapability(AdminFeedbackController, "list")).not.toBe(
      declaredCapability(AdminPiiRevealController, "revealContact"),
    );
  });

  it("analyst and ops_admin may read feedback but are DENIED the contact reveal", () => {
    for (const role of ["analyst", "ops_admin"] as AdminRole[]) {
      expect(guard.canActivate(ctxFor(AdminFeedbackController, "list", admin(role)))).toBe(true);
      expect(() =>
        guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin(role))),
      ).toThrow(ForbiddenException);
    }
  });
});

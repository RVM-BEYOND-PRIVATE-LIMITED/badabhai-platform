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
 *   1. Only `read_identity` holders read it (owner ruling #2926, option 1, 2026-11-18):
 *      super_admin, ops_admin and support. `analyst` is refused with a 403: a worker's own
 *      words can carry their name or phone number, and an analyst sees neither anywhere else
 *      in the portal. An UNKNOWN role is refused too (`can()` is deny-by-default).
 *   2. An unauthenticated caller is refused with a 401, never a silent allow.
 *   3. Reading feedback is NOT resolving who wrote it. The feedback gate must stay distinct
 *      from `reveal_pii`: an ops_admin who can see "my supervisor takes my wages" must not
 *      thereby be able to resolve whose phone number that is.
 */

const READERS: AdminRole[] = ["super_admin", "ops_admin", "support"];
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
  it("declares read_identity — the EXISTING capability that gates names (#2926)", () => {
    expect(declaredCapability(AdminFeedbackController, "list")).toBe("read_identity");
    expect(ADMIN_CAPABILITIES).toContain("read_identity");
  });

  it("super_admin, ops_admin and support pass", () => {
    for (const role of READERS) {
      expect(guard.canActivate(ctxFor(AdminFeedbackController, "list", admin(role)))).toBe(true);
    }
  });

  it("analyst is REFUSED (403): a worker's own words can carry their name or phone (#2926)", () => {
    expect(() => guard.canActivate(ctxFor(AdminFeedbackController, "list", admin("analyst")))).toThrow(
      ForbiddenException,
    );
  });

  it("a principal whose role does NOT hold read_identity is refused (deny-by-default)", () => {
    // The realistic shape of "lacks the capability" on this surface: a role the matrix has
    // never heard of. `can()` denies it rather than defaulting to a privileged role, so an
    // enum widened without a matrix row fails closed instead of opening this read.
    for (const rogue of ["root", "viewer", "", "read_identity"]) {
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

  it("ops_admin may read feedback but is DENIED the contact reveal", () => {
    expect(guard.canActivate(ctxFor(AdminFeedbackController, "list", admin("ops_admin")))).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin("ops_admin"))),
    ).toThrow(ForbiddenException);
  });

  it("analyst is denied BOTH the feedback read and the contact reveal", () => {
    for (const ctor of [AdminFeedbackController, AdminPiiRevealController] as const) {
      const method = ctor === AdminFeedbackController ? "list" : "revealContact";
      expect(() => guard.canActivate(ctxFor(ctor, method, admin("analyst")))).toThrow(
        ForbiddenException,
      );
    }
  });
});

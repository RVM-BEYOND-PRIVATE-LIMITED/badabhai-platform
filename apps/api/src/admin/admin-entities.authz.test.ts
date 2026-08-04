import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { AdminEntitiesController } from "./admin-entities.controller";
import { AdminActionsController } from "./admin-actions.controller";

/**
 * Per-ROLE authz matrix for the BP-1 entity-read routes, driving the REAL {@link AdminRolesGuard}
 * with each route's REAL declared capability.
 *
 * The property that matters is not "all four roles can read" — it is the SEPARATION: the same
 * `:id` that an analyst may READ is one an analyst may not SUSPEND. `GET /admin/payers/:id` and
 * `POST /admin/payers/:id/suspend` differ by nothing but the verb, so the only thing keeping
 * read access from becoming write access is that they declare different capabilities. That is
 * asserted directly below.
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

const READ_ROUTES = [
  "listWorkers",
  "getWorker",
  "listPayers",
  "getPayer",
  "getPayerCredits",
  "listJobPostings",
  "getJobPosting",
  "listApplications",
] as const;

describe("BP-1 authz matrix — the entity read floor (read_entities, all four roles)", () => {
  for (const route of READ_ROUTES) {
    it(`${route}: ALL four roles pass`, () => {
      for (const role of ROLES) {
        expect(guard.canActivate(ctxFor(AdminEntitiesController, route, admin(role)))).toBe(true);
      }
    });

    it(`${route}: unauthenticated → 401 (fail closed, never a silent allow)`, () => {
      expect(() => guard.canActivate(ctxFor(AdminEntitiesController, route, undefined))).toThrow(
        UnauthorizedException,
      );
    });

    it(`${route}: an unknown role is DENIED (deny-by-default, not defaulted to a privileged role)`, () => {
      const rogue = { id: "a", role: "root" as AdminRole, sid: "s" };
      expect(() => guard.canActivate(ctxFor(AdminEntitiesController, route, rogue))).toThrow(
        ForbiddenException,
      );
    });

    it(`${route} really declares read_entities (not read_events, not a write capability)`, () => {
      expect(declaredCapability(AdminEntitiesController, route)).toBe("read_entities");
    });
  }
});

describe("BP-1 — reading an entity NEVER confers acting on it", () => {
  /**
   * The pairs that share a path and differ only by verb. If a future change ever gave the read
   * route a write capability (or the reverse), these are the assertions that catch it — and the
   * role used is `analyst`, the one that legitimately holds every read and no write.
   */
  const PAIRS: Array<{ read: (typeof READ_ROUTES)[number]; write: string }> = [
    { read: "getPayer", write: "suspendPayer" },
    { read: "getPayerCredits", write: "grantCredits" },
    { read: "getJobPosting", write: "forceClosePosting" },
    { read: "getWorker", write: "flagWorker" },
  ];

  for (const { read, write } of PAIRS) {
    it(`analyst may ${read} but is DENIED ${write} (same target, different privilege)`, () => {
      expect(guard.canActivate(ctxFor(AdminEntitiesController, read, admin("analyst")))).toBe(true);
      expect(() =>
        guard.canActivate(ctxFor(AdminActionsController, write, admin("analyst"))),
      ).toThrow(ForbiddenException);
    });

    it(`${read} and ${write} declare DIFFERENT capabilities`, () => {
      expect(declaredCapability(AdminEntitiesController, read)).not.toBe(
        declaredCapability(AdminActionsController, write),
      );
    });
  }

  it("support may read every entity but may not perform any entity action", () => {
    for (const route of READ_ROUTES) {
      expect(guard.canActivate(ctxFor(AdminEntitiesController, route, admin("support")))).toBe(
        true,
      );
    }
    for (const write of ["suspendPayer", "grantCredits", "forceClosePosting", "flagWorker"]) {
      expect(() =>
        guard.canActivate(ctxFor(AdminActionsController, write, admin("support"))),
      ).toThrow(ForbiddenException);
    }
  });
});

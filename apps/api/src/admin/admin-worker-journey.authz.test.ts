import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { ADMIN_CAPABILITIES, type AdminCapability } from "./admin-capabilities";
import { AdminWorkerJourneyController } from "./admin-worker-journey.controller";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";

/**
 * Per-ROLE authz matrix for the Phase 6 worker-journey routes, driving the REAL
 * {@link AdminRolesGuard} with each route's REAL declared capability.
 *
 * ── THE RBAC DECISION THESE TESTS PIN ───────────────────────────────────────────────────
 * The journey reads sit on `read_entities`, the existing read floor, rather than on a new
 * capability. The argument is in the controller header; what matters here is that the
 * decision is ASSERTED rather than assumed, in three directions:
 *
 *   - all four roles hold it (it is the read floor, same as the entity detail these reads
 *     are assembled from);
 *   - reading a worker's journey confers NO action on that worker — an analyst who can see
 *     that a worker stalled at question 4 still cannot flag them;
 *   - and, the load-bearing one, it does NOT confer `reveal_pii`. A journey shows question
 *     KEYS and statuses; a transcript would be a different data class entirely and is not
 *     served here. If a transcript read is ever added, THAT is what earns its own capability.
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

const JOURNEY_ROUTES = ["getJourneySummary", "listChatSessions", "getChatSession"] as const;

describe("Phase 6 authz matrix — the journey reads sit on the `read_entities` floor", () => {
  for (const route of JOURNEY_ROUTES) {
    it(`${route}: ALL four roles pass`, () => {
      for (const role of ROLES) {
        expect(guard.canActivate(ctxFor(AdminWorkerJourneyController, route, admin(role)))).toBe(
          true,
        );
      }
    });

    it(`${route}: unauthenticated → 401 (fail closed, never a silent allow)`, () => {
      expect(() =>
        guard.canActivate(ctxFor(AdminWorkerJourneyController, route, undefined)),
      ).toThrow(UnauthorizedException);
    });

    it(`${route}: an unknown role is DENIED (deny-by-default, never defaulted to privileged)`, () => {
      const rogue = { id: "a", role: "root" as AdminRole, sid: "s" };
      expect(() => guard.canActivate(ctxFor(AdminWorkerJourneyController, route, rogue))).toThrow(
        ForbiddenException,
      );
    });

    it(`${route} really declares read_entities (not read_events, not a write capability)`, () => {
      expect(declaredCapability(AdminWorkerJourneyController, route)).toBe("read_entities");
    });
  }
});

describe("Phase 6 — seeing a worker's journey NEVER confers acting on them", () => {
  /**
   * `analyst` is the role that legitimately holds every read and no write, so it is the one
   * that makes the separation visible.
   */
  const WRITES = ["flagWorker", "unflagWorker", "suspendPayer", "grantCredits"] as const;

  for (const write of WRITES) {
    it(`analyst may read a journey but is DENIED ${write}`, () => {
      expect(
        guard.canActivate(ctxFor(AdminWorkerJourneyController, "getJourneySummary", admin("analyst"))),
      ).toBe(true);
      expect(() =>
        guard.canActivate(ctxFor(AdminActionsController, write, admin("analyst"))),
      ).toThrow(ForbiddenException);
    });
  }

  it("every journey route declares a DIFFERENT capability from flagging a worker", () => {
    for (const route of JOURNEY_ROUTES) {
      expect(declaredCapability(AdminWorkerJourneyController, route)).not.toBe(
        declaredCapability(AdminActionsController, "flagWorker"),
      );
    }
  });
});

describe("Phase 6 — the journey is NOT a PII surface and confers nothing on the PII surface", () => {
  it("an ops_admin may read a journey and is still DENIED reveal-contact", () => {
    // `reveal_pii` is super_admin + support ONLY. The journey read must not become a side
    // door to it — which it cannot be, because it declares a different capability AND returns
    // no PII: question keys, statuses, counts, timings, opaque ids.
    expect(
      guard.canActivate(ctxFor(AdminWorkerJourneyController, "getChatSession", admin("ops_admin"))),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin("ops_admin"))),
    ).toThrow(ForbiddenException);
  });

  it("the journey routes declare a different capability from the PII reveal", () => {
    for (const route of JOURNEY_ROUTES) {
      expect(declaredCapability(AdminWorkerJourneyController, route)).not.toBe(
        declaredCapability(AdminPiiRevealController, "revealContact"),
      );
    }
  });

  it("NO new capability was minted for this surface (the matrix is pinned to a signed ADR)", () => {
    // `ADMIN_CAPABILITIES` is transcribed verbatim from ADR-0025 Decision 3.1 by the
    // matrix-drift test. Adding a member is an ADR amendment, not a backend decision — and a
    // half-added one would also leave `apps/admin-web`'s exhaustive CAPABILITY_LABELS
    // incomplete, which a backend-only PR cannot fix.
    expect([...ADMIN_CAPABILITIES].sort()).toEqual(
      [
        "export",
        "flag_worker",
        "force_close_posting",
        "grant_credits",
        "manage_admins",
        "read_entities",
        "read_events",
        "reveal_pii",
        "suspend_payer",
        "toggle_kill_switch",
      ].sort(),
    );
    // ...and every journey route uses one of them.
    for (const route of JOURNEY_ROUTES) {
      expect(ADMIN_CAPABILITIES).toContain(declaredCapability(AdminWorkerJourneyController, route));
    }
  });
});

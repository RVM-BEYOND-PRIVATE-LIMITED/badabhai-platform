import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { ADMIN_CAPABILITIES, can, type AdminCapability } from "./admin-capabilities";
import { AdminAiTracesController } from "./admin-ai-traces.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";
import { AdminFeedbackController } from "./admin-feedback.controller";

/**
 * Per-ROLE authz for the 0083 trace routes, driving the REAL {@link AdminRolesGuard} with each
 * route's REAL declared capability.
 *
 * ── THE PROPERTY UNDER TEST IS THE RULING, NOT THE GUARD ────────────────────────────────
 * `AdminRolesGuard` already has its own suite. What is pinned here is the OWNER RULING: "read is
 * gated on a NEW capability `read_ai_traces`, super_admin ONLY", on BOTH routes over this table.
 * An earlier cut put the LIST on `read_entities` and argued it well — ops triage should not cost
 * the privacy question — but that widened a stated ruling, which CLAUDE.md §16 reserves for a
 * human. The argument is written out in the controller header, waiting on a ruling.
 *
 * If either route ever picked up `read_entities` — by a class-level decorator, by a copy-paste,
 * by someone "making the module consistent" — the flag would still default off, the cap would
 * still charge and the audit row would still be written. They would simply be written for
 * `analyst`, the role the 2026-08-18 ruling deliberately left faceless. The list needs none of
 * those controls to be a disclosure: walked end to end it is an index of which worker spoke, in
 * which interview, when, and how much.
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

describe("GET /admin/ai-traces — the PII-free list is on the SAME gate as the decrypt", () => {
  it("declares read_ai_traces, per the owner ruling — NOT the read floor", () => {
    expect(declaredCapability(AdminAiTracesController, "list")).toBe("read_ai_traces");
    // Stated as an inequality too, because `read_entities` is the value a "make it consistent
    // with the other admin lists" edit would reach for, and it is the one value that is wrong.
    expect(declaredCapability(AdminAiTracesController, "list")).not.toBe("read_entities");
  });

  it("ONLY super_admin passes — the other three are refused, list included", () => {
    // What the list hands over is the LINKAGE — which worker, which session, which task, when,
    // how much they said — keyset-walkable across the whole worker base. That is a different
    // disclosure from a name, not a lesser one, and `packages/db/src/schema-contract.ts` calls
    // it the worst silent leak on this spine.
    expect(guard.canActivate(ctxFor(AdminAiTracesController, "list", admin("super_admin")))).toBe(
      true,
    );
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() => guard.canActivate(ctxFor(AdminAiTracesController, "list", admin(role)))).toThrow(
        ForbiddenException,
      );
    }
  });

  it("an unknown role is refused (deny-by-default), and an unauthenticated caller gets 401", () => {
    for (const rogue of ["root", "viewer", "", "read_entities"]) {
      const who = { id: "a", role: rogue as AdminRole, sid: "s" };
      expect(() => guard.canActivate(ctxFor(AdminAiTracesController, "list", who))).toThrow(
        ForbiddenException,
      );
    }
    expect(() => guard.canActivate(ctxFor(AdminAiTracesController, "list", undefined))).toThrow(
      UnauthorizedException,
    );
  });
});

describe("GET /admin/ai-traces/:id — the DECRYPT is super_admin ONLY", () => {
  it("declares read_ai_traces, and it is a real member of the vocabulary", () => {
    expect(declaredCapability(AdminAiTracesController, "readOne")).toBe("read_ai_traces");
    expect(ADMIN_CAPABILITIES).toContain("read_ai_traces");
  });

  it("ONLY super_admin passes — the other three are refused with a 403", () => {
    expect(guard.canActivate(ctxFor(AdminAiTracesController, "readOne", admin("super_admin")))).toBe(
      true,
    );
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() =>
        guard.canActivate(ctxFor(AdminAiTracesController, "readOne", admin(role))),
      ).toThrow(ForbiddenException);
    }
  });

  it("`support` may reveal a phone but may NOT read what a worker said", () => {
    // The separation that decides where this capability belongs. `reveal_pii` is held by the role
    // whose job is calling a worker back, and folding trace decryption into it would silently hand
    // the entire support function every prompt on the platform — with nothing in the matrix, the
    // ADR or `GET /admin/capabilities` recording that the row had changed meaning.
    expect(can("support", "reveal_pii")).toBe(true);
    expect(can("support", "read_ai_traces")).toBe(false);
    expect(guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin("support")))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(ctxFor(AdminAiTracesController, "readOne", admin("support"))),
    ).toThrow(ForbiddenException);
  });

  it("`ops_admin` reaches NEITHER route — one ruling, one gate, both legs", () => {
    // The case that changed. `ops_admin` used to reach the list and be refused the text; the
    // ruling says the whole read is super_admin, so both are 403 until an owner says otherwise.
    for (const route of ["list", "readOne"]) {
      expect(() =>
        guard.canActivate(ctxFor(AdminAiTracesController, route, admin("ops_admin"))),
      ).toThrow(ForbiddenException);
    }
  });

  it("BOTH routes declare the same capability — a future third route cannot drift", () => {
    expect(declaredCapability(AdminAiTracesController, "list")).toBe(
      declaredCapability(AdminAiTracesController, "readOne"),
    );
  });

  it("`read_ai_traces` is a STRICT SUBSET of `reveal_pii` — never the other way round", () => {
    // A role that may read a worker's words is a role that may already resolve who they are.
    // The reverse would be the strange one: an account entitled to everything somebody said but
    // not to their phone number would still be able to identify them from what they said.
    for (const role of ROLES) {
      if (can(role, "read_ai_traces")) expect(can(role, "reveal_pii"), role).toBe(true);
    }
  });

  it("the three text-bearing admin surfaces declare THREE DIFFERENT capabilities", () => {
    // Feedback (a worker's complaint), a phone reveal, and a whole prompt are three data classes.
    // If any two ever collapsed onto one capability, the narrowest of them would silently widen
    // to the broadest allow-set.
    const caps = [
      declaredCapability(AdminFeedbackController, "list"),
      declaredCapability(AdminPiiRevealController, "revealContact"),
      declaredCapability(AdminAiTracesController, "readOne"),
    ];
    expect(new Set(caps).size).toBe(3);
  });

  it("unauthenticated → 401, and a null role → 403 (fail closed, never a silent allow)", () => {
    expect(() => guard.canActivate(ctxFor(AdminAiTracesController, "readOne", undefined))).toThrow(
      UnauthorizedException,
    );
    const who = { id: "a", role: null as unknown as AdminRole, sid: "s" };
    expect(() => guard.canActivate(ctxFor(AdminAiTracesController, "readOne", who))).toThrow(
      ForbiddenException,
    );
  });
});

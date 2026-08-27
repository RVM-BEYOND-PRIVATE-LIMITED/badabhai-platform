import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import {
  ADMIN_CAPABILITIES,
  ADMIN_CAPABILITY_MATRIX,
  can,
  capabilitiesFor,
  type AdminCapability,
} from "./admin-capabilities";

/** Build an ExecutionContext carrying the given @RequireAdminRole capability (or none) + admin. */
function makeCtx(opts: {
  capability?: AdminCapability;
  admin?: AuthenticatedAdmin | undefined;
}): ExecutionContext {
  const handler = () => undefined;
  if (opts.capability) Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, opts.capability, handler);
  const req = { admin: opts.admin };
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

// ---------------------------------------------------------------------------
// Deny-by-default RBAC enforcement.
// ---------------------------------------------------------------------------
describe("AdminRolesGuard (ADR-0025 Decision 3 — deny-by-default)", () => {
  it("ALLOWS support on a reveal_pii route; REJECTS (403) ops_admin and analyst", () => {
    expect(guard.canActivate(makeCtx({ capability: "reveal_pii", admin: admin("support") }))).toBe(true);
    expect(guard.canActivate(makeCtx({ capability: "reveal_pii", admin: admin("super_admin") }))).toBe(true);
    expect(() => guard.canActivate(makeCtx({ capability: "reveal_pii", admin: admin("ops_admin") }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(makeCtx({ capability: "reveal_pii", admin: admin("analyst") }))).toThrow(
      ForbiddenException,
    );
  });

  it("ALLOWS ops_admin on suspend_payer; REJECTS support and analyst", () => {
    expect(guard.canActivate(makeCtx({ capability: "suspend_payer", admin: admin("ops_admin") }))).toBe(true);
    expect(() => guard.canActivate(makeCtx({ capability: "suspend_payer", admin: admin("support") }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(makeCtx({ capability: "suspend_payer", admin: admin("analyst") }))).toThrow(
      ForbiddenException,
    );
  });

  it("toggle_kill_switch + manage_admins are super_admin-only (break-glass)", () => {
    for (const cap of ["toggle_kill_switch", "manage_admins"] as const) {
      expect(guard.canActivate(makeCtx({ capability: cap, admin: admin("super_admin") }))).toBe(true);
      for (const role of ["ops_admin", "support", "analyst"] as const) {
        expect(() => guard.canActivate(makeCtx({ capability: cap, admin: admin(role) }))).toThrow(
          ForbiddenException,
        );
      }
    }
  });

  it("read_events is the read floor — every role passes", () => {
    for (const role of ["super_admin", "ops_admin", "support", "analyst"] as const) {
      expect(guard.canActivate(makeCtx({ capability: "read_events", admin: admin(role) }))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // REGRESSION: a route that mounts this guard and forgets @RequireAdminRole used to
  // return true, exposing a privileged route to all four roles. It must now DENY.
  // -------------------------------------------------------------------------
  it("DENIES (403) a route with NO @RequireAdminRole metadata — for EVERY role, incl. super_admin", () => {
    for (const role of ["super_admin", "ops_admin", "support", "analyst"] as const) {
      expect(() => guard.canActivate(makeCtx({ admin: admin(role) }))).toThrow(ForbiddenException);
    }
  });

  it("the undeclared-capability denial is INDISTINGUISHABLE from a real authz denial (no oracle)", () => {
    // Same exception type and same message, so a caller cannot tell a misconfigured route
    // from one they simply lack the capability for.
    const undeclared = (() => {
      try {
        guard.canActivate(makeCtx({ admin: admin("analyst") }));
      } catch (e) {
        return e as ForbiddenException;
      }
    })();
    const denied = (() => {
      try {
        guard.canActivate(makeCtx({ capability: "manage_admins", admin: admin("analyst") }));
      } catch (e) {
        return e as ForbiddenException;
      }
    })();
    expect(undeclared).toBeInstanceOf(ForbiddenException);
    expect(denied).toBeInstanceOf(ForbiddenException);
    expect(undeclared!.getStatus()).toBe(denied!.getStatus());
    expect(undeclared!.message).toBe(denied!.message);
  });

  it("DENIES an undeclared route even when req.admin is absent (403 before the 401 branch)", () => {
    // The misconfiguration check runs first, so an unauthenticated probe of a mounted-but-
    // undeclared route learns nothing about whether the route declares a capability.
    expect(() => guard.canActivate(makeCtx({ admin: undefined }))).toThrow(ForbiddenException);
  });

  it("REJECTS (401) when req.admin is absent on a DECLARED route (guards misordered — fail closed)", () => {
    expect(() => guard.canActivate(makeCtx({ capability: "read_events", admin: undefined }))).toThrow(
      UnauthorizedException,
    );
  });

  it("@RequireAdminRole attaches the capability as reflector metadata", () => {
    class C {
      handler() {
        /* no-op */
      }
    }
    RequireAdminRole("export")(C.prototype, "handler", Object.getOwnPropertyDescriptor(C.prototype, "handler")!);
    expect(new Reflector().get<AdminCapability>(ADMIN_CAPABILITY_KEY, C.prototype.handler)).toBe("export");
  });
});

// ---------------------------------------------------------------------------
// can() deny-by-default + an unknown role is never privileged.
// ---------------------------------------------------------------------------
describe("can() — deny-by-default capability check", () => {
  it("a null/undefined/unknown role is denied every capability (never defaulted)", () => {
    for (const cap of ADMIN_CAPABILITIES) {
      expect(can(null, cap)).toBe(false);
      expect(can(undefined, cap)).toBe(false);
      expect(can("ghost" as AdminRole, cap)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// MUST-FIX #5 — matrix-drift: pin the constant to the ADR Decision-3 table.
// ---------------------------------------------------------------------------
describe("capability matrix drift (must-fix #5 — pinned to ADR-0025 Decision 3.1)", () => {
  // The EXACT ADR Decision-3.1 table, transcribed as allow-sets per capability. A silent
  // over-grant (or accidental removal) in ADMIN_CAPABILITY_MATRIX fails this test → CI.
  const EXPECTED: Record<AdminCapability, AdminRole[]> = {
    read_events: ["super_admin", "ops_admin", "support", "analyst"],
    read_entities: ["super_admin", "ops_admin", "support", "analyst"],
    // Owner ruling 2026-08-18 (reversing Decision 4's faceless contract): the NAMES behind the
    // ids, on both the list and the detail. `analyst` DENIED.
    read_identity: ["super_admin", "ops_admin", "support"],
    // Migration 0083 — DECRYPT a stored prompt/completion. SUPER_ADMIN ONLY, and not held
    // by `support` even though `reveal_pii` is: revealing one worker's phone on a
    // reason-gated route and reading what every worker has said are different acts.
    read_ai_traces: ["super_admin"],
    export: ["super_admin", "ops_admin"],
    suspend_payer: ["super_admin", "ops_admin"],
    grant_credits: ["super_admin", "ops_admin"],
    force_close_posting: ["super_admin", "ops_admin"],
    flag_worker: ["super_admin", "ops_admin"],
    // Migration 0093 — RECORD a review decision on one skill candidate (taxonomy authorship).
    // THE ONE ROW HERE WITH NO SIGNED ADR CELL BEHIND IT: ADR-0025 §3.1's table has twelve rows
    // and this is the thirteenth capability. Transcribed from the backend's reasoned default in
    // `admin-capabilities.ts` (governed-write allow-set, because the write reaches one queue row
    // and a recommendation — the corpus is minted only by the offline chain, behind a second
    // human), NOT from the ADR. An owner ruling plus the §3.1 row is still owed; until it lands
    // this test pins the code against the code, which is drift detection but not ADR compliance.
    review_skill_candidates: ["super_admin", "ops_admin"],
    toggle_kill_switch: ["super_admin"],
    reveal_pii: ["super_admin", "support"],
    manage_admins: ["super_admin"],
  };

  it("the capability set matches the ADR exactly (no added/removed capability)", () => {
    expect([...ADMIN_CAPABILITIES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("every capability's allow-set matches the ADR Decision-3 table EXACTLY", () => {
    for (const cap of ADMIN_CAPABILITIES) {
      expect([...ADMIN_CAPABILITY_MATRIX[cap]].sort()).toEqual([...EXPECTED[cap]].sort());
    }
  });

  it("the every-cell assertion: can(role, cap) === (role ∈ the ADR cell) for ALL 52 cells", () => {
    const roles: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
    for (const cap of ADMIN_CAPABILITIES) {
      for (const role of roles) {
        expect(can(role, cap)).toBe(EXPECTED[cap].includes(role));
      }
    }
  });

  it("the deliberate separations hold: support cannot export; ops_admin cannot reveal PII", () => {
    expect(can("support", "export")).toBe(false); // the reveal role must not also bulk-export
    expect(can("ops_admin", "reveal_pii")).toBe(false); // mutations role gets no PII
    expect(can("analyst", "export")).toBe(false);
    // 0093 — taxonomy authorship is NOT a PII act, so it must NOT inherit the `reveal_pii`
    // allow-set. Asserted on the role that separates the two: `support` holds `reveal_pii` and
    // is denied this, which is the whole reason the capability is not folded into that row.
    expect(can("support", "review_skill_candidates")).toBe(false);
    expect(can("super_admin", "review_skill_candidates")).toBe(true);
    expect(can("ops_admin", "review_skill_candidates")).toBe(true);
  });

  it("read_entities is a READ floor, never an implicit write grant (BP-1)", () => {
    // The entity reads sit next to entity ACTIONS on the same paths (`GET /admin/payers/:id`
    // beside `POST /admin/payers/:id/suspend`). Being able to see a payer must never imply
    // being able to change one — assert the separation on the role that has the read and
    // none of the writes.
    expect(can("analyst", "read_entities")).toBe(true);
    for (const write of [
      "suspend_payer",
      "grant_credits",
      "force_close_posting",
      "flag_worker",
      // 0093 — the read floor reaches the candidate QUEUE (list/detail/metrics on
      // `read_entities`, so an analyst can measure the backlog) and must never reach the
      // DECISION. This is the assertion that keeps those two apart.
      "review_skill_candidates",
      "manage_admins",
      "toggle_kill_switch",
    ] as const) {
      expect(can("analyst", write)).toBe(false);
    }
    // ...and that reading entities never smuggles in the PII capability.
    expect(can("analyst", "reveal_pii")).toBe(false);
    expect(can("ops_admin", "reveal_pii")).toBe(false);
  });

  it("read_identity is a STRICT SUBSET of read_entities — names can only narrow the floor", () => {
    // The property that makes the split safe in BOTH directions. If a role ever held
    // `read_identity` without `read_entities` it would be entitled to a name on a screen it
    // cannot open, which is a matrix that says something no route can honour. And because the
    // identity check is INSIDE the service rather than on a second decorator, a superset would
    // not fail anywhere — it would just be silently unreachable.
    for (const role of ["super_admin", "ops_admin", "support", "analyst"] as AdminRole[]) {
      if (can(role, "read_identity")) expect(can(role, "read_entities"), role).toBe(true);
    }
    // ...and the ruling itself, pinned literally: three roles in, `analyst` out.
    expect(can("super_admin", "read_identity")).toBe(true);
    expect(can("ops_admin", "read_identity")).toBe(true);
    expect(can("support", "read_identity")).toBe(true);
    expect(can("analyst", "read_identity")).toBe(false);
    // Names are NOT the reveal: `ops_admin` holds identity and is still denied the phone.
    expect(can("ops_admin", "reveal_pii")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesFor — the list GET /admin/me hands the Admin Portal. It exists so the
// frontend never carries a second copy of the matrix, which makes ONE property the thing
// that matters: it must agree with the guard on every cell, forever.
// ---------------------------------------------------------------------------
describe("capabilitiesFor — what the UI is told matches what the server permits", () => {
  const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];

  it("agrees with can() on ALL 52 cells — the UI can never show a control the guard denies", () => {
    for (const role of ROLES) {
      const granted = capabilitiesFor(role);
      for (const cap of ADMIN_CAPABILITIES) {
        // Both directions. Missing a capability hides a control the admin is entitled to;
        // including one the guard denies renders a button that only ever 403s.
        expect(granted.includes(cap)).toBe(can(role, cap));
      }
    }
  });

  it("fails CLOSED for a null/undefined role — no session, no capabilities", () => {
    expect(capabilitiesFor(null)).toEqual([]);
    expect(capabilitiesFor(undefined)).toEqual([]);
  });

  it("returns each role's exact ADR-0025 §3.1 grant", () => {
    // Literal expectations: an assertion derived from the matrix would survive a matrix bug.
    // `analyst` is the role the 2026-08-18 ruling deliberately left faceless — no read_identity.
    expect(capabilitiesFor("analyst")).toEqual(["read_events", "read_entities"]);
    expect(capabilitiesFor("support")).toEqual([
      "read_events",
      "read_entities",
      "read_identity",
      "reveal_pii",
    ]);
    expect(capabilitiesFor("ops_admin")).toEqual([
      "read_events",
      "read_entities",
      "read_identity",
      "export",
      "suspend_payer",
      "grant_credits",
      "force_close_posting",
      "flag_worker",
      // 0093 — taxonomy authorship. Appended at the TAIL of ops_admin's grant deliberately:
      // this literal is order-sensitive against `ADMIN_CAPABILITIES`, and placing the new
      // capability anywhere but the end of the governed-write block would move an existing row.
      "review_skill_candidates",
    ]);
    // super_admin holds everything — the one role for which the list is the whole vocabulary.
    expect(capabilitiesFor("super_admin")).toEqual([...ADMIN_CAPABILITIES]);
  });

  it("no role but super_admin is handed a break-glass capability", () => {
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(capabilitiesFor(role)).not.toContain("toggle_kill_switch");
      expect(capabilitiesFor(role)).not.toContain("manage_admins");
    }
  });
});

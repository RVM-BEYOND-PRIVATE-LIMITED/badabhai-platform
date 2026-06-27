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

  it("NO-OP: a route with NO @RequireAdminRole metadata is not tightened (any admin passes)", () => {
    expect(guard.canActivate(makeCtx({ admin: admin("analyst") }))).toBe(true);
  });

  it("REJECTS (401) when req.admin is absent (guards misordered / auth skipped — fail closed)", () => {
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
    export: ["super_admin", "ops_admin"],
    suspend_payer: ["super_admin", "ops_admin"],
    grant_credits: ["super_admin", "ops_admin"],
    force_close_posting: ["super_admin", "ops_admin"],
    flag_worker: ["super_admin", "ops_admin"],
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

  it("the every-cell assertion: can(role, cap) === (role ∈ the ADR cell) for ALL 36 cells", () => {
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
  });
});

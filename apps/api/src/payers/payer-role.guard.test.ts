import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PayerRole } from "@badabhai/db";
import type { AuthenticatedPayer } from "./payer-auth.guard";
import { PayerRoleGuard, PayerRoles, PAYER_ROLES_KEY } from "./payer-role.guard";

/**
 * VERTICAL-authz build-blocker (ADR-0022 sign-off). Proves the agent-only primitive:
 *   - an `employer` token is REJECTED (403) on an @PayerRoles("agent") route;
 *   - an `agent` token is ALLOWED;
 *   - a route with NO @PayerRoles metadata is a NO-OP (never tightened);
 *   - the fail-closed case (role unresolvable → null) is REJECTED, never defaulted.
 *
 * Distinct from horizontal authz (assertPayerOwns / IDOR), which is row-level and is
 * covered by payer-scope.test.ts + payer-account.controller.test.ts.
 */

/**
 * Build an ExecutionContext whose handler/class carry the given @PayerRoles metadata
 * (or none) and whose request has the given authenticated payer (or none). This mirrors
 * what PayerAuthGuard attaches + what @PayerRoles declares — exactly the guard's inputs.
 */
function makeCtx(opts: {
  allowed?: PayerRole[]; // @PayerRoles(...) metadata; omit = no metadata (no-op route)
  payer?: AuthenticatedPayer | undefined; // req.payer set by PayerAuthGuard
}): ExecutionContext {
  const handler = () => undefined;
  if (opts.allowed) Reflect.defineMetadata(PAYER_ROLES_KEY, opts.allowed, handler);
  const req = { payer: opts.payer };
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new PayerRoleGuard(new Reflector());

const agent: AuthenticatedPayer = { id: "p-agent", sid: "s", role: "agent" };
const employer: AuthenticatedPayer = { id: "p-emp", sid: "s", role: "employer" };
const unresolved: AuthenticatedPayer = { id: "p-unknown", sid: "s", role: null };

describe("PayerRoleGuard (ADR-0022 vertical authz)", () => {
  it("ALLOWS an agent token on an @PayerRoles('agent') route", () => {
    expect(guard.canActivate(makeCtx({ allowed: ["agent"], payer: agent }))).toBe(true);
  });

  it("REJECTS (403) an employer token on an @PayerRoles('agent') route", () => {
    expect(() => guard.canActivate(makeCtx({ allowed: ["agent"], payer: employer }))).toThrow(
      ForbiddenException,
    );
  });

  it("NO-OP: a route with NO @PayerRoles metadata never tightens (any role passes)", () => {
    expect(guard.canActivate(makeCtx({ payer: employer }))).toBe(true);
    expect(guard.canActivate(makeCtx({ payer: agent }))).toBe(true);
    // Even an unresolved role passes an UNDECORATED route — the guard only gates declared ones.
    expect(guard.canActivate(makeCtx({ payer: unresolved }))).toBe(true);
  });

  it("FAIL-CLOSED: an unresolvable role (null) is REJECTED (403), never treated as agent", () => {
    expect(() => guard.canActivate(makeCtx({ allowed: ["agent"], payer: unresolved }))).toThrow(
      ForbiddenException,
    );
  });

  it("multi-role set: a payer in the allowed set passes; one outside is rejected", () => {
    const both: PayerRole[] = ["agent", "employer"];
    expect(guard.canActivate(makeCtx({ allowed: both, payer: employer }))).toBe(true);
    expect(() => guard.canActivate(makeCtx({ allowed: ["employer"], payer: agent }))).toThrow(
      ForbiddenException,
    );
  });

  it("REJECTS (401) when req.payer is absent (guards misordered / auth skipped)", () => {
    expect(() => guard.canActivate(makeCtx({ allowed: ["agent"], payer: undefined }))).toThrow(
      UnauthorizedException,
    );
  });

  it("@PayerRoles attaches the allowed-role set as reflector metadata", () => {
    class C {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      handler() {}
    }
    PayerRoles("agent")(C.prototype, "handler", Object.getOwnPropertyDescriptor(C.prototype, "handler")!);
    const meta = new Reflector().get<PayerRole[]>(PAYER_ROLES_KEY, C.prototype.handler);
    expect(meta).toEqual(["agent"]);
  });
});

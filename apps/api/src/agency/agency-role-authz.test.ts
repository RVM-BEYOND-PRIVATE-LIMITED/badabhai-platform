import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PayerRole } from "@badabhai/db";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PAYER_ROLES_KEY } from "../payers/payer-role.guard";
import { AgencyJobsController } from "./agency-jobs.controller";
import { AgencyInvitesController } from "./agency-invites.controller";
import { AgencyPayoutsController } from "./agency-payouts.controller";

/**
 * VERTICAL-authz end-to-end assertion (ADR-0022 security-gate follow-up): binds the REAL
 * agency controllers' `@PayerRoles('agent')` metadata to {@link PayerRoleGuard} and proves
 * an authenticated EMPLOYER principal is 403'd while an AGENT passes — through the actual
 * route classes, not a synthetic one. Complements guard-contract.test.ts (which proves the
 * guards are ATTACHED) and payer-role.guard.test.ts (the guard's unit behaviour).
 */

const guard = new PayerRoleGuard(new Reflector());
const agent: AuthenticatedPayer = { id: "p-agent", sid: "s", role: "agent" };
const employer: AuthenticatedPayer = { id: "p-emp", sid: "s", role: "employer" };
const unresolved: AuthenticatedPayer = { id: "p-x", sid: "s", role: null };

/** ctx whose getClass() is the REAL agency controller (carrying the class-level @PayerRoles). */
function ctxFor(controller: new (...args: never[]) => object, payer: AuthenticatedPayer): ExecutionContext {
  const handler = () => undefined; // no method-level metadata → resolves the class-level set
  const req = { payer };
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const CONTROLLERS: Array<[string, new (...args: never[]) => object]> = [
  ["AgencyJobsController", AgencyJobsController],
  ["AgencyInvitesController", AgencyInvitesController],
  // The supply-money surface (KYC + earnings + payouts) is agent-only too (ADR-0022 Amdt 2).
  ["AgencyPayoutsController", AgencyPayoutsController],
];

describe("Agency controllers — vertical authz is agent-only (real metadata + guard)", () => {
  for (const [name, ctor] of CONTROLLERS) {
    describe(name, () => {
      it("declares @PayerRoles('agent') at the class level", () => {
        const roles = new Reflector().get<PayerRole[]>(PAYER_ROLES_KEY, ctor);
        expect(roles).toEqual(["agent"]);
      });

      it("ALLOWS an agent principal", () => {
        expect(guard.canActivate(ctxFor(ctor, agent))).toBe(true);
      });

      it("REJECTS (403) an employer principal", () => {
        expect(() => guard.canActivate(ctxFor(ctor, employer))).toThrow(ForbiddenException);
      });

      it("REJECTS (403) an unresolved (null) role — never treated as agent", () => {
        expect(() => guard.canActivate(ctxFor(ctor, unresolved))).toThrow(ForbiddenException);
      });
    });
  }
});

/**
 * ADR-0022 Amendment 3, condition C7 — the BATCH mint route inherits the class guards and
 * takes its tenancy from the SESSION. A new POST on an existing controller is the classic
 * place a guard is forgotten or a convenience `payer_id` creeps into the body, and an N-row
 * write amplifies any tenancy slip N×.
 */
describe("createInviteBatch — guards + tenancy (C7)", () => {
  const handler = AgencyInvitesController.prototype.createInviteBatch;

  it("the batch handler exists and carries Nest route metadata", () => {
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata("path", handler)).toBe("invites/batch");
  });

  it("resolves the class-level @PayerRoles('agent') — an EMPLOYER is rejected like every sibling", () => {
    const ctx = ctxForHandler(AgencyInvitesController, handler, employer);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("ALLOWS an agent principal on the batch route", () => {
    expect(guard.canActivate(ctxForHandler(AgencyInvitesController, handler, agent))).toBe(true);
  });

  it("REJECTS an unresolved (null) role on the batch route", () => {
    const ctx = ctxForHandler(AgencyInvitesController, handler, unresolved);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("declares the SAME guard pair as the singular mint (no method-level divergence)", () => {
    const clsGuards = (Reflect.getMetadata("__guards__", AgencyInvitesController) ?? []) as Array<{
      name: string;
    }>;
    expect(clsGuards.map((g) => g.name).sort()).toEqual(["PayerAuthGuard", "PayerRoleGuard"]);
    // No method-level guard set that could REPLACE or weaken the class pair.
    expect(Reflect.getMetadata("__guards__", handler)).toBeUndefined();
  });

  /**
   * The batch handler's payer argument is the `@CurrentPayer()` session principal. There is
   * no route/body path by which a foreign payer id could reach `inviter_payer_id` — the DTO
   * is `.strict()` so `{payer_id}`/`{inviter_payer_id}` is a 400 (asserted in
   * agency.dto.test.ts), and the service stamps the value it is HANDED, which is the session.
   */
  it("takes the payer from the SESSION decorator, never a body/param", () => {
    const params = (Reflect.getMetadata("__routeArguments__", AgencyInvitesController, "createInviteBatch") ??
      {}) as Record<string, unknown>;
    const keys = Object.keys(params);
    // Nest encodes param type as `<typeEnum>:<index>`. 3 === RequestParamtypes.BODY,
    // 4 === PARAM, 5 === QUERY — only ONE body arg (the DTO) and no param/query at all.
    expect(keys.filter((k) => k.startsWith("3:"))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith("4:") || k.startsWith("5:"))).toHaveLength(0);
  });
});

/** ctx bound to a SPECIFIC handler (method-level metadata resolution), not just the class. */
function ctxForHandler(
  controller: new (...args: never[]) => object,
  handler: unknown,
  payer: AuthenticatedPayer,
): ExecutionContext {
  const req = { payer };
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

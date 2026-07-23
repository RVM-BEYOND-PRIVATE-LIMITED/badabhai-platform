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

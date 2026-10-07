import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { OrgRole } from "@badabhai/db";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerOrgRoleGuard, ORG_ROLES_KEY } from "../payers/payer-org-role.guard";
import type { PayerOrgsRepository, ResolvedOrg } from "../payers/payer-orgs.repository";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import { PayerOrgMembersController } from "./payer-org-members.controller";

/**
 * #2079 (ADR-0027 / B5.3) — billing + member management are ORG-OWNER-only, server-side.
 *
 * Binds the REAL controllers' `@UseGuards` / `@OrgRoles` metadata to the REAL
 * {@link PayerOrgRoleGuard} (with a stubbed membership read) and proves, per protected route:
 *   - an OWNER is admitted,
 *   - a RECRUITER is refused (403),
 *   - a payer with NO active membership (removed / unknown) is refused (403),
 *   - a membership-read ERROR is refused (403 — fail closed),
 *   - a DEMOTED owner loses access on the very next request (the guard reads the CURRENT role
 *     from the DB every time — the session's `org_role` claim is never consulted).
 * And that the read/unlock routes a recruiter needs stay open (no over-tightening).
 */

type Ctor = new (...args: never[]) => object;
type Handler = (...args: never[]) => unknown;

const PAYER: AuthenticatedPayer = { id: "p-1", sid: "s-1", role: "employer" };
const ORG_ID = "org-1";

function handlerOf(controller: Ctor, method: string): Handler {
  return (controller.prototype as Record<string, Handler>)[method]!;
}

/** A guard whose membership read is driven by `resolve` (called once per request). */
function guardWith(resolve: () => Promise<ResolvedOrg | null>) {
  const resolveOrgForPayer = vi.fn(resolve);
  const guard = new PayerOrgRoleGuard(new Reflector(), {
    resolveOrgForPayer,
  } as unknown as PayerOrgsRepository);
  return { guard, resolveOrgForPayer };
}

function ctxFor(controller: Ctor, method: string) {
  const req: { payer: AuthenticatedPayer; payerOrg?: ResolvedOrg } = { payer: PAYER };
  const ctx = {
    getHandler: () => handlerOf(controller, method),
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

const member = (orgRole: OrgRole): (() => Promise<ResolvedOrg>) => async () => ({
  orgId: ORG_ID,
  orgRole,
});

const PROTECTED: ReadonlyArray<readonly [Ctor, string, string]> = [
  [PayerUnlocksController, "buyPack", "POST /payer/credits"],
  [PayerUnlocksController, "createOrder", "POST /payer/credits/order"],
  [PayerUnlocksController, "verifyPayment", "POST /payer/credits/verify"],
  [PayerOrgMembersController, "invite", "POST /payer/org/members"],
  [PayerOrgMembersController, "remove", "DELETE /payer/org/members/:id"],
];

describe("owner-only billing + member management (#2079)", () => {
  for (const [controller, method, route] of PROTECTED) {
    describe(route, () => {
      it("mounts PayerOrgRoleGuard and declares @OrgRoles('owner')", () => {
        const handler = handlerOf(controller, method);
        const guards = [
          ...((Reflect.getMetadata("__guards__", controller) ?? []) as Array<{ name: string }>),
          ...((Reflect.getMetadata("__guards__", handler) ?? []) as Array<{ name: string }>),
        ].map((g) => g.name);
        expect(guards).toContain("PayerAuthGuard");
        expect(guards).toContain("PayerOrgRoleGuard");
        // PayerAuthGuard must run FIRST (it attaches req.payer the org guard reads).
        expect(guards.indexOf("PayerAuthGuard")).toBeLessThan(guards.indexOf("PayerOrgRoleGuard"));
        expect(new Reflector().get<OrgRole[]>(ORG_ROLES_KEY, handler)).toEqual(["owner"]);
      });

      it("ADMITS an owner (and attaches the resolved org)", async () => {
        const { guard } = guardWith(member("owner"));
        const { ctx, req } = ctxFor(controller, method);
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(req.payerOrg).toEqual({ orgId: ORG_ID, orgRole: "owner" });
      });

      it("REFUSES (403) a recruiter", async () => {
        const { guard } = guardWith(member("recruiter"));
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });

      it("REFUSES (403) a payer with no active membership (removed / unknown role)", async () => {
        const { guard } = guardWith(async () => null);
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });

      it("REFUSES (403) when the membership read fails — fail closed, never open", async () => {
        const { guard } = guardWith(async () => {
          throw new Error("pg down");
        });
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });

      it("a DEMOTED owner loses access on the very next request (current role, per request)", async () => {
        let role: OrgRole = "owner";
        const { guard, resolveOrgForPayer } = guardWith(async () => ({ orgId: ORG_ID, orgRole: role }));
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).resolves.toBe(true);
        role = "recruiter"; // demoted between two requests on the SAME session
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(resolveOrgForPayer).toHaveBeenCalledTimes(2);
        expect(resolveOrgForPayer).toHaveBeenLastCalledWith(PAYER.id);
      });
    });
  }

  // No over-tightening: what a recruiter does day-to-day stays open to every member.
  const OPEN_TO_MEMBERS = [
    "requestUnlock",
    "reveal",
    "listOwn",
    "ownCredits",
    "creditsLedger",
  ] as const;
  for (const method of OPEN_TO_MEMBERS) {
    it(`PayerUnlocksController.${method} carries no org-role gate (recruiters keep it)`, () => {
      const handler = handlerOf(PayerUnlocksController, method);
      const guards = ((Reflect.getMetadata("__guards__", handler) ?? []) as Array<{ name: string }>).map(
        (g) => g.name,
      );
      expect(guards).not.toContain("PayerOrgRoleGuard");
      expect(new Reflector().get<OrgRole[] | undefined>(ORG_ROLES_KEY, handler)).toBeUndefined();
    });
  }
});

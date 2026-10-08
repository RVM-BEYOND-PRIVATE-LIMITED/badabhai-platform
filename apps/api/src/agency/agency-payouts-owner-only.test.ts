import "reflect-metadata";
import { describe, it, expect } from "vitest";
import {
  ForbiddenException,
  HttpException,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ServerConfig } from "@badabhai/config";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { ORG_ROLES_KEY, PayerOrgRoleGuard } from "../payers/payer-org-role.guard";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { ActiveMembershipFacts } from "../payers/payer-tenant-scope";
import type { TeamFixture } from "../payers/payer-tenant-scope.test-support";
import { PayerOrgMembersController } from "../payer-portal/payer-org-members.controller";
import { AgencyPayoutsController } from "./agency-payouts.controller";
import { AgencyPayoutsEnabledGuard } from "./agency-payouts-enabled.guard";

/**
 * ADR-0053 owner ruling O-5 — agency KYC, earnings and payouts are ORG-level and OWNER-ONLY,
 * and that must hold BEFORE `AGENCY_PAYOUTS_ENABLED` flips.
 *
 * Binds the REAL `AgencyPayoutsController` metadata (`@OrgRoles("owner")` + its guard list) to
 * the REAL `PayerOrgRoleGuard` over the REAL resolver, in BOTH tenancy modes:
 *  - the org's OWNER is admitted on every route;
 *  - a RECRUITER member is refused with the SAME 403 the team-management routes give a recruiter
 *    (`PayerOrgMembersController.invite`) — no new message, so no new oracle;
 *  - a payer with NO org membership is refused (fail closed);
 *  - an OUTSIDER is the owner of their own org: admitted, and the services key them to their own
 *    tenant (agency-kyc.service.test.ts / agency-payout.service.test.ts), never to the team's;
 *  - with the flag OFF, the owner and the recruiter get the SAME 404, because the flag gate runs
 *    BEFORE the org-role gate (no org-role oracle on an inert surface).
 * guard-contract.test.ts pins that the guard is mounted and in that order.
 */

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const RECRUITER = "77777777-7777-4777-8777-777777777777";
const OUTSIDER = "88888888-8888-4888-8888-888888888888";
const ORGLESS = "99999999-9999-4999-8999-999999999999";
const TEAM: TeamFixture[] = [{ anchor: ANCHOR, members: [RECRUITER] }];

const MODES = ["off", "on"] as const;
const configFor = (mode: (typeof MODES)[number], payoutsEnabled = true) =>
  ({
    PAYER_ORG_TENANCY_MODE: mode,
    AGENCY_PAYOUTS_ENABLED: payoutsEnabled,
  }) as unknown as ServerConfig;

/** One ACTIVE membership as the resolver's read returns it (rule R1). */
function membership(anchor: string, actor: string, acceptedAt: string): ActiveMembershipFacts {
  return {
    orgId: `org-of-${anchor}`,
    orgRole: anchor === actor ? "owner" : "recruiter",
    acceptedAt: new Date(acceptedAt),
    orgStatus: "active",
    anchorPayerId: anchor,
    anchorRole: "agent",
    anchorStatus: "active",
    memberRole: "agent",
  };
}

/**
 * The REAL resolver over a fixed agency world: every payer owns a solo org (the signup
 * invariant), RECRUITER also joined ANCHOR's team (later, so `off`'s most-recent tie-break picks
 * the team too), and ORGLESS has no membership at all — and none heals.
 */
function resolverFor(mode: (typeof MODES)[number]): PayerTenantScopeService {
  const orgs = {
    listActiveMembershipsWithAnchor: async (actor: string): Promise<ActiveMembershipFacts[]> =>
      actor === ORGLESS
        ? []
        : [
            membership(actor, actor, "2026-01-01T00:00:00.000Z"),
            ...TEAM.filter((t) => t.anchor !== actor && t.members.includes(actor)).map((t) =>
              membership(t.anchor, actor, "2026-02-01T00:00:00.000Z"),
            ),
          ],
    ensureSoloOrg: async (): Promise<void> => undefined,
  };
  return new PayerTenantScopeService(configFor(mode), orgs as unknown as PayerOrgsRepository);
}

const ROUTES = ["submitKyc", "getKyc", "getEarnings", "requestPayout", "listPayouts"] as const;

function ctx(
  controller: new (...args: never[]) => object,
  method: string,
  payerId: string,
): ExecutionContext {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  const payer: AuthenticatedPayer = { id: payerId, sid: "s", role: "agent" };
  const req = { payer };
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** The refusal a guard throws, as status + body (what the client sees), or "allowed". */
async function outcome(guard: CanActivate, context: ExecutionContext): Promise<string> {
  try {
    return (await guard.canActivate(context)) ? "allowed" : "denied";
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    return JSON.stringify({ status: err.getStatus(), body: err.getResponse() });
  }
}

describe("AgencyPayoutsController — O-5: KYC, earnings and payouts are OWNER-ONLY", () => {
  it("declares @OrgRoles('owner') at the CLASS level, so every route inherits it and none overrides it", () => {
    expect(Reflect.getMetadata(ORG_ROLES_KEY, AgencyPayoutsController)).toEqual(["owner"]);
    for (const route of ROUTES) {
      const handler = (AgencyPayoutsController.prototype as unknown as Record<string, object>)[
        route
      ]!;
      expect(Reflect.getMetadata(ORG_ROLES_KEY, handler), route).toBeUndefined();
    }
  });

  for (const mode of MODES) {
    describe(`tenancy mode ${mode}`, () => {
      const guard = new PayerOrgRoleGuard(new Reflector(), resolverFor(mode));

      it("ADMITS the org's owner on every route", async () => {
        for (const route of ROUTES) {
          expect(await outcome(guard, ctx(AgencyPayoutsController, route, ANCHOR)), route).toBe(
            "allowed",
          );
        }
      });

      it("REFUSES a recruiter member on every route with the team routes' own 403 (no new oracle)", async () => {
        const teamRefusal = await outcome(
          guard,
          ctx(PayerOrgMembersController, "invite", RECRUITER),
        );
        expect(JSON.parse(teamRefusal)).toMatchObject({ status: 403 });
        for (const route of ROUTES) {
          expect(await outcome(guard, ctx(AgencyPayoutsController, route, RECRUITER)), route).toBe(
            teamRefusal,
          );
        }
        await expect(
          guard.canActivate(ctx(AgencyPayoutsController, "requestPayout", RECRUITER)),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it("REFUSES a payer with no org membership (fail closed)", async () => {
        for (const route of ROUTES) {
          const refusal = await outcome(guard, ctx(AgencyPayoutsController, route, ORGLESS));
          expect(JSON.parse(refusal), route).toMatchObject({ status: 403 });
        }
      });

      it("ADMITS an outsider only as the owner of their OWN org", async () => {
        const context = ctx(AgencyPayoutsController, "getKyc", OUTSIDER);
        expect(await outcome(guard, context)).toBe("allowed");
        const req = context.switchToHttp().getRequest<{ payerOrg?: { orgId: string } }>();
        expect(req.payerOrg?.orgId).toBe(`org-of-${OUTSIDER}`);
      });
    });
  }

  describe("the flag gate runs FIRST: an inert surface is no org-role oracle", () => {
    /** The class's own guards after authn + the vertical role gate, in declared order. */
    function chain(mode: (typeof MODES)[number], payoutsEnabled: boolean): CanActivate[] {
      const declared = (
        Reflect.getMetadata("__guards__", AgencyPayoutsController) as { name: string }[]
      ).map((g) => g.name);
      const built: Record<string, CanActivate> = {
        AgencyPayoutsEnabledGuard: new AgencyPayoutsEnabledGuard(configFor(mode, payoutsEnabled)),
        PayerOrgRoleGuard: new PayerOrgRoleGuard(new Reflector(), resolverFor(mode)),
      };
      return declared.filter((name) => name in built).map((name) => built[name]!);
    }

    async function run(guards: CanActivate[], context: ExecutionContext): Promise<string> {
      for (const g of guards) {
        const out = await outcome(g, context);
        if (out !== "allowed") return out;
      }
      return "allowed";
    }

    for (const mode of MODES) {
      it(`mode ${mode}, flag OFF: the owner and the recruiter get the SAME neutral 404 on every route`, async () => {
        const guards = chain(mode, false);
        expect(guards).toHaveLength(2);
        const notFound = JSON.stringify({
          status: 404,
          body: new NotFoundException().getResponse(),
        });
        for (const route of ROUTES) {
          for (const who of [ANCHOR, RECRUITER, ORGLESS]) {
            expect(await run(guards, ctx(AgencyPayoutsController, route, who)), route).toBe(
              notFound,
            );
          }
        }
      });

      it(`mode ${mode}, flag ON: the owner passes; the recruiter is the 403`, async () => {
        const guards = chain(mode, true);
        expect(await run(guards, ctx(AgencyPayoutsController, "getEarnings", ANCHOR))).toBe(
          "allowed",
        );
        const refusal = await run(guards, ctx(AgencyPayoutsController, "getEarnings", RECRUITER));
        expect(JSON.parse(refusal)).toMatchObject({ status: 403 });
      });
    }
  });
});

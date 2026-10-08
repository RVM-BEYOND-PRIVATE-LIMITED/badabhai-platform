import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import type { ActiveMembershipFacts, PayerTenantScope, TenantKey } from "./payer-tenant-scope";
import type { PayerOrgsRepository } from "./payer-orgs.repository";
import { PayerTenantScopeService } from "./payer-tenant-scope.service";

/**
 * Test support for ADR-0053 (PAY-DB-01). Not compiled into the build (`*.test-support.ts` is
 * excluded by tsconfig.build.json).
 *
 * A suite gets its `TenantKey`s and scopes the only way production code can: from the REAL
 * {@link PayerTenantScopeService}, here reading an in-memory membership table. Nothing here casts
 * to a tenancy type (S-F1, `payer-tenancy.static.test.ts`), so a unit suite exercises the same
 * resolution a request does — the default mode (`off`) keys the actor, `on` keys a team member to
 * the anchor.
 *
 * This file never names the mode flag, which has exactly one reader in non-test source (T8): a
 * suite that wants `on` builds that config itself and hands it to {@link resolverOver}; the
 * helpers here that take no config use the flag's DEFAULT (`off`, pinned by the config tests).
 */

/** A team org: `anchor` founded it; every id in `members` is an active recruiter in it. */
export interface TeamFixture {
  readonly anchor: string;
  readonly members: readonly string[];
}

/** An active membership row as the resolver's read returns it (R1), for one org. */
function membership(
  anchorPayerId: string,
  actorPayerId: string,
  acceptedAt: Date,
): ActiveMembershipFacts {
  return {
    orgId: `org-of-${anchorPayerId}`,
    orgRole: anchorPayerId === actorPayerId ? "owner" : "recruiter",
    acceptedAt,
    orgStatus: "active",
    anchorPayerId,
    anchorRole: "employer",
    anchorStatus: "active",
    memberRole: "employer",
  };
}

/**
 * The REAL resolver over a fixed world: every actor owns a solo org (the signup invariant), and an
 * actor listed in a team's `members` is also an active recruiter of that team. An actor in no team
 * resolves to themselves in every mode (solo identity, ADR-0053 §5.3).
 */
export function resolverOver(
  config: ServerConfig,
  teams: readonly TeamFixture[] = [],
): PayerTenantScopeService {
  const orgs = {
    listActiveMembershipsWithAnchor: async (actor: string): Promise<ActiveMembershipFacts[]> => [
      membership(actor, actor, new Date("2026-01-01T00:00:00.000Z")),
      ...teams
        .filter((team) => team.anchor !== actor && team.members.includes(actor))
        .map((team) => membership(team.anchor, actor, new Date("2026-02-01T00:00:00.000Z"))),
    ],
    ensureSoloOrg: async (): Promise<never> => {
      throw new Error("test support: every actor already has a solo org");
    },
  };
  return new PayerTenantScopeService(config, orgs as unknown as PayerOrgsRepository);
}

/** The REAL resolver in the DEFAULT mode (`off`): every payer is their own tenant, as before. */
export function defaultModeResolver(teams: readonly TeamFixture[] = []): PayerTenantScopeService {
  return resolverOver(loadServerConfig({ NODE_ENV: "test" }), teams);
}

/** The scope the default mode resolves for `payerId`: actor and tenant are both the payer. */
export function ownScope(payerId: string): Promise<PayerTenantScope> {
  return defaultModeResolver().resolve(payerId);
}

/** The tenant key the default mode resolves for `payerId` — the payer itself, never a cast. */
export async function ownTenantKey(payerId: string): Promise<TenantKey> {
  return (await ownScope(payerId)).tenantKey;
}

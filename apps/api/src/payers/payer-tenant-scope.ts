import type { OrgRole, PayerOrgStatus, PayerRole, PayerStatus } from "@badabhai/db";

/**
 * ADR-0053 (PAY-DB-01) — the payer TENANT KEY and the pure acting-org decision.
 *
 * The org is the tenant. Its key is the org's ANCHOR, `payer_orgs.root_payer_id`, stored in the
 * payer-reference columns that already exist (no `org_id` column). Org and anchor are 1:1 and
 * immutable, so the anchor identifies the org exactly.
 *
 * This file is pure: no DI, no database, no config. {@link import("./payer-tenant-scope.service").PayerTenantScopeService}
 * reads the memberships, reads the mode, and calls {@link chooseActingOrg}. Everything that
 * decides WHICH org a payer acts in lives here, so the Team page (`PayerOrgRoleGuard`), the
 * session org claim, `GET /payer/me` and (from Phase 2) every tenant-row predicate share one
 * choice and cannot disagree.
 */

declare const tenantKeyBrand: unique symbol;

/**
 * The acting org's anchor id, as the key for every tenant-row predicate and stamp.
 *
 * BRANDED so a raw id from a body, a path or a JWT claim cannot be passed where a tenant key
 * is expected. The brand is a compile-time device, so it holds only while nothing casts to it:
 * the one constructor is the private `asTenantKey` below (reached through {@link chooseActingOrg},
 * which only the resolver service calls), and `payer-tenancy.static.test.ts` fails on any type
 * assertion to this type — or to {@link PayerTenantScope} / {@link ActingOrgChoice}, or to an
 * alias or interface built on one — anywhere else in non-test source. What the brand CANNOT stop:
 * a value typed `any` (an unparsed request body, `JSON.parse`) assigns to it with no cast, and
 * the lint config has no type-aware `no-unsafe-argument`. Inputs reach the payer services only as
 * Zod-parsed DTOs and the session id; Phase 2 reviews must keep it that way. Phase 2 retypes the
 * tenant repositories to accept this type instead of `string`.
 */
export type TenantKey = string & { readonly [tenantKeyBrand]: true };

/** `PAYER_ORG_TENANCY_MODE` (packages/config). Read by the resolver service only. */
export type PayerOrgTenancyMode = "off" | "shadow" | "on";

/** The resolved tenancy for one request (ADR-0053 §5.1). Resolve once, pass it down. */
export interface PayerTenantScope {
  /** The authenticated login: event envelope actor, `created_by`, rate limits, member-private rows. */
  readonly actorPayerId: string;
  /** Every tenant-row predicate and every tenant-row stamp. */
  readonly tenantKey: TenantKey;
  /** The acting org. `null` only in `off`/`shadow` when the actor has no active membership. */
  readonly orgId: string | null;
  readonly orgRole: OrgRole | null;
  readonly mode: PayerOrgTenancyMode;
}

/**
 * One ACTIVE membership of the actor, joined to its org and to the org's anchor (rule R1).
 * `memberRole` is the actor's own `payers.role` (the same on every row).
 */
export interface ActiveMembershipFacts {
  readonly orgId: string;
  readonly orgRole: OrgRole;
  readonly acceptedAt: Date | null;
  readonly orgStatus: PayerOrgStatus;
  readonly anchorPayerId: string;
  readonly anchorRole: PayerRole;
  readonly anchorStatus: PayerStatus;
  readonly memberRole: PayerRole;
}

/** Why `on` refuses to resolve a tenant. Logged (ids only); the response is one neutral 403. */
export type TenancyDenial =
  | "multiple_team_memberships" // R3
  | "no_membership" // R4, after the heal
  | "org_inactive" // R5
  | "anchor_inactive" // R5 (O-6)
  | "role_mismatch"; // R6 (O-9)

export type ActingOrgChoice =
  | { readonly kind: "resolved"; readonly scope: PayerTenantScope }
  /** `on` only (R4): no active membership at all. The service heals once, then decides again. */
  | { readonly kind: "no_membership" }
  | { readonly kind: "denied"; readonly reason: TenancyDenial };

/**
 * A TEAM membership: one in an org someone else anchors. The one spelling of "team" — the
 * resolver's R2/R3 and invite rule A1 (`PayerOrgMembersService.accept`) both use it, so they can
 * never disagree about who is already in a team.
 */
export function isTeamMembership(
  membership: Pick<ActiveMembershipFacts, "anchorPayerId">,
  actorPayerId: string,
): boolean {
  return membership.anchorPayerId !== actorPayerId;
}

/** The only constructor of a {@link TenantKey}. Deliberately not exported. */
function asTenantKey(payerId: string): TenantKey {
  return payerId as TenantKey;
}

/**
 * The org a payer acts in, and the tenant key, for one mode (ADR-0053 §3.2).
 *
 * `off` and `shadow` SERVE the pre-ADR behaviour exactly: the tenant key is the actor, and the
 * org is the most recently accepted active membership (the tie-break `resolveOrgForPayer` used,
 * `ORDER BY accepted_at DESC`, under which Postgres puts a NULL first). They never deny.
 *
 * `on`:
 *  - R2 (team wins): exactly one membership in an org whose anchor is not the actor → that org.
 *    No such membership → the actor's solo org (the one it anchors).
 *  - R3: more than one team membership → denied (fail closed).
 *  - R4: no membership to act in → `no_membership`; the service heals with `ensureSoloOrg`.
 *  - R5: the acting org is not `active` → denied. When the actor is NOT the acting org's anchor,
 *    the anchor not being `active` → denied too (O-6). The anchor-status check is skipped only
 *    when the actor IS the anchor: their own status is judged by `PayerAuthGuard`, not here
 *    (ADR-0053 §3.2 R5, amended 2026-10-08).
 *  - R6: the actor's vertical role differs from the anchor's → denied (O-9).
 */
export function chooseActingOrg(
  memberships: readonly ActiveMembershipFacts[],
  actorPayerId: string,
  mode: PayerOrgTenancyMode,
): ActingOrgChoice {
  if (mode !== "on") {
    const latest = mostRecentlyAccepted(memberships);
    return {
      kind: "resolved",
      scope: {
        actorPayerId,
        tenantKey: asTenantKey(actorPayerId),
        orgId: latest?.orgId ?? null,
        orgRole: latest?.orgRole ?? null,
        mode,
      },
    };
  }

  const team = memberships.filter((m) => isTeamMembership(m, actorPayerId));
  if (team.length > 1) return { kind: "denied", reason: "multiple_team_memberships" };
  const acting = team[0] ?? memberships.find((m) => m.anchorPayerId === actorPayerId);
  if (!acting) return { kind: "no_membership" };

  if (acting.orgStatus !== "active") return { kind: "denied", reason: "org_inactive" };
  // O-6: an anchor's suspension blocks every member who is not the anchor. When the actor IS the
  // anchor, their own status is PayerAuthGuard's to judge (it admits only `active`), and login
  // resolves the org BEFORE a first-time payer is activated — judging it here refused every first
  // login in `on` and broke solo identity (ADR-0053 §3.2 R5 as amended, §5.3).
  const actorIsNonAnchorMember = isTeamMembership(acting, actorPayerId);
  if (actorIsNonAnchorMember && acting.anchorStatus !== "active") {
    return { kind: "denied", reason: "anchor_inactive" };
  }
  if (acting.memberRole !== acting.anchorRole) return { kind: "denied", reason: "role_mismatch" };

  return {
    kind: "resolved",
    scope: {
      actorPayerId,
      tenantKey: asTenantKey(acting.anchorPayerId),
      orgId: acting.orgId,
      orgRole: acting.orgRole,
      mode,
    },
  };
}

/**
 * Today's tie-break, made explicit so it does not depend on the order rows arrive in:
 * `accepted_at DESC` with NULL first (Postgres' default for DESC). Equal timestamps keep their
 * input order (a stable sort), as an unordered tie did before.
 */
function mostRecentlyAccepted(
  memberships: readonly ActiveMembershipFacts[],
): ActiveMembershipFacts | undefined {
  const newerFirst = (a: ActiveMembershipFacts, b: ActiveMembershipFacts): number => {
    if (a.acceptedAt === null || b.acceptedAt === null) {
      return (b.acceptedAt === null ? 1 : 0) - (a.acceptedAt === null ? 1 : 0);
    }
    return b.acceptedAt.getTime() - a.acceptedAt.getTime();
  };
  return [...memberships].sort(newerFirst)[0];
}

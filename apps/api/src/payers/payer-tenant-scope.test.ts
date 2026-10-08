import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayerOrgStatus, PayerRole, PayerStatus } from "@badabhai/db";
import {
  chooseActingOrg,
  isTeamMembership,
  type ActiveMembershipFacts,
  type PayerOrgTenancyMode,
} from "./payer-tenant-scope";
import { Reflector } from "@nestjs/core";
import { PayerTenantScopeService, TENANCY_DENIED_MESSAGE } from "./payer-tenant-scope.service";
import type { PayerOrgsRepository } from "./payer-orgs.repository";
import { PayerOrgRoleGuard } from "./payer-org-role.guard";
import { resolveSessionOrgClaim } from "./payer-session-org-claim";
import { PayerAccountService } from "./payer-account.service";
import type { PayersRepository } from "./payers.repository";

/**
 * ADR-0053 (PAY-DB-01) — the tenant resolver.
 *  - T3: every rule R1–R7, including each fail-closed path, and `off` never failing a request.
 *  - T1: SOLO IDENTITY, over an exhaustively generated space of membership sets: `on` keys a
 *    payer to anyone but themselves ONLY when they are a non-anchor member of exactly one team.
 */

const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_ANCHOR = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER_ANCHOR = "cccccccc-0000-4000-8000-000000000003";

function m(
  anchorPayerId: string,
  over: Partial<ActiveMembershipFacts> = {},
): ActiveMembershipFacts {
  return {
    // A uuid (GET /payer/me validates it) that is distinct per anchor.
    orgId: `0${anchorPayerId.slice(1)}`,
    orgRole: anchorPayerId === ACTOR ? "owner" : "recruiter",
    acceptedAt: new Date("2026-06-01T00:00:00.000Z"),
    orgStatus: "active",
    anchorPayerId,
    anchorRole: "employer",
    anchorStatus: "active",
    memberRole: "employer",
    ...over,
  };
}

const SOLO = m(ACTOR, { acceptedAt: new Date("2026-05-01T00:00:00.000Z") });
const TEAM = m(TEAM_ANCHOR, { acceptedAt: new Date("2026-07-01T00:00:00.000Z") });

describe("chooseActingOrg — off / shadow serve the pre-ADR answer", () => {
  it.each<PayerOrgTenancyMode>(["off", "shadow"])(
    "%s: the tenant key is the actor, even for a team member",
    (mode) => {
      const choice = chooseActingOrg([SOLO, TEAM], ACTOR, mode);
      expect(choice).toEqual({
        kind: "resolved",
        scope: {
          actorPayerId: ACTOR,
          tenantKey: ACTOR,
          orgId: TEAM.orgId,
          orgRole: "recruiter",
          mode,
        },
      });
    },
  );

  it("off picks the MOST RECENTLY accepted membership, whatever order the rows arrive in", () => {
    // The team org was accepted later. Today's read was `ORDER BY accepted_at DESC LIMIT 1`.
    for (const rows of [
      [SOLO, TEAM],
      [TEAM, SOLO],
    ]) {
      const choice = chooseActingOrg(rows, ACTOR, "off");
      expect(choice.kind === "resolved" && choice.scope.orgId).toBe(TEAM.orgId);
    }
    // …and an older team membership loses to a newer solo one: off is recency, not R2.
    const olderTeam = m(TEAM_ANCHOR, { acceptedAt: new Date("2026-01-01T00:00:00.000Z") });
    const choice = chooseActingOrg([olderTeam, SOLO], ACTOR, "off");
    expect(choice.kind === "resolved" && choice.scope.orgId).toBe(SOLO.orgId);
  });

  it("off puts a NULL accepted_at first, as Postgres orders DESC", () => {
    const unstamped = m(OTHER_ANCHOR, { acceptedAt: null });
    for (const rows of [
      [SOLO, TEAM, unstamped],
      [unstamped, TEAM, SOLO],
    ]) {
      const choice = chooseActingOrg(rows, ACTOR, "off");
      expect(choice.kind === "resolved" && choice.scope.orgId).toBe(unstamped.orgId);
    }
  });

  it("off with no membership still resolves: the actor is the tenant, the org is null", () => {
    expect(chooseActingOrg([], ACTOR, "off")).toEqual({
      kind: "resolved",
      scope: { actorPayerId: ACTOR, tenantKey: ACTOR, orgId: null, orgRole: null, mode: "off" },
    });
  });

  it("off never denies — not even on rows `on` would refuse", () => {
    const hostile = [
      m(TEAM_ANCHOR, { orgStatus: "suspended" }),
      m(OTHER_ANCHOR, { anchorStatus: "suspended", anchorRole: "agent" }),
    ];
    for (const mode of ["off", "shadow"] as const) {
      const choice = chooseActingOrg(hostile, ACTOR, mode);
      expect(choice.kind).toBe("resolved");
      expect(choice.kind === "resolved" && choice.scope.tenantKey).toBe(ACTOR);
    }
  });
});

describe("isTeamMembership — the ONE 'team' predicate (R2/R3 here, accept rule A1)", () => {
  it("is a team membership exactly when someone other than the actor anchors the org", () => {
    expect(isTeamMembership(TEAM, ACTOR)).toBe(true);
    expect(isTeamMembership(SOLO, ACTOR)).toBe(false);
    // The org role does not decide it: an owner row in someone else's org is still a team row.
    expect(isTeamMembership(m(TEAM_ANCHOR, { orgRole: "owner" }), ACTOR)).toBe(true);
    expect(isTeamMembership(m(ACTOR, { orgRole: "recruiter" }), ACTOR)).toBe(false);
  });
});

describe("chooseActingOrg — on (ADR-0053 §3.2)", () => {
  it("R2: a single team membership wins — the key is the team's ANCHOR", () => {
    // Even when the solo org was accepted MORE recently (the opposite of off's tie-break).
    const recentSolo = m(ACTOR, { acceptedAt: new Date("2026-09-01T00:00:00.000Z") });
    expect(chooseActingOrg([recentSolo, TEAM], ACTOR, "on")).toEqual({
      kind: "resolved",
      scope: {
        actorPayerId: ACTOR,
        tenantKey: TEAM_ANCHOR,
        orgId: TEAM.orgId,
        orgRole: "recruiter",
        mode: "on",
      },
    });
  });

  it("R2: no team membership → the actor's own solo org, keyed by the actor", () => {
    expect(chooseActingOrg([SOLO], ACTOR, "on")).toEqual({
      kind: "resolved",
      scope: {
        actorPayerId: ACTOR,
        tenantKey: ACTOR,
        orgId: SOLO.orgId,
        orgRole: "owner",
        mode: "on",
      },
    });
  });

  it("R2: a team membership resolves even without a solo row", () => {
    const choice = chooseActingOrg([TEAM], ACTOR, "on");
    expect(choice.kind === "resolved" && choice.scope.tenantKey).toBe(TEAM_ANCHOR);
  });

  it("R3: more than one team membership is DENIED (fail closed), solo row or not", () => {
    const second = m(OTHER_ANCHOR);
    for (const rows of [
      [TEAM, second],
      [SOLO, TEAM, second],
    ]) {
      expect(chooseActingOrg(rows, ACTOR, "on")).toEqual({
        kind: "denied",
        reason: "multiple_team_memberships",
      });
    }
  });

  it("R4: no active membership at all → no_membership (the service heals, then decides again)", () => {
    expect(chooseActingOrg([], ACTOR, "on")).toEqual({ kind: "no_membership" });
  });

  it("R5: a suspended acting org is denied", () => {
    expect(
      chooseActingOrg([SOLO, m(TEAM_ANCHOR, { orgStatus: "suspended" })], ACTOR, "on"),
    ).toEqual({ kind: "denied", reason: "org_inactive" });
  });

  it.each<PayerStatus>(["suspended", "pending"])(
    "R5 (O-6): an anchor whose payers.status is %s blocks every member",
    (anchorStatus) => {
      expect(chooseActingOrg([SOLO, m(TEAM_ANCHOR, { anchorStatus })], ACTOR, "on")).toEqual({
        kind: "denied",
        reason: "anchor_inactive",
      });
    },
  );

  it.each<PayerStatus>(["pending", "suspended"])(
    "R5 does NOT judge the actor's own status on their solo org (%s) — authentication does",
    (anchorStatus) => {
      // Login resolves the org BEFORE a first-time payer is activated (pending), and the ops
      // routes may name a payer of any status. Neither is a team concern (O-6), and denying
      // here would break solo identity: the key must still be the actor.
      expect(chooseActingOrg([m(ACTOR, { anchorStatus })], ACTOR, "on")).toEqual({
        kind: "resolved",
        scope: {
          actorPayerId: ACTOR,
          tenantKey: ACTOR,
          orgId: SOLO.orgId,
          orgRole: "owner",
          mode: "on",
        },
      });
    },
  );

  it("R6 (O-9): a member whose vertical role differs from the anchor's is denied", () => {
    const agencyTeam = m(TEAM_ANCHOR, { anchorRole: "agent", memberRole: "employer" });
    expect(chooseActingOrg([SOLO, agencyTeam], ACTOR, "on")).toEqual({
      kind: "denied",
      reason: "role_mismatch",
    });
    const sameRole = m(TEAM_ANCHOR, { anchorRole: "agent", memberRole: "agent" });
    expect(chooseActingOrg([sameRole], ACTOR, "on").kind).toBe("resolved");
  });
});

describe("T1 — solo identity, over every generated membership set", () => {
  const ORG_STATUSES: PayerOrgStatus[] = ["active", "suspended"];
  const PAYER_STATUSES: PayerStatus[] = ["active", "pending", "suspended"];
  const ROLES: PayerRole[] = ["employer", "agent"];

  /** Every variant of one membership row in an org anchored by `anchor`. */
  function variants(anchor: string, memberRole: PayerRole): ActiveMembershipFacts[] {
    const out: ActiveMembershipFacts[] = [];
    for (const orgStatus of ORG_STATUSES)
      // The actor's OWN status varies too: a first-time payer is still `pending` when login
      // resolves their org, and solo identity must hold for them as well.
      for (const anchorStatus of PAYER_STATUSES)
        for (const anchorRole of anchor === ACTOR ? [memberRole] : ROLES)
          out.push(m(anchor, { orgStatus, anchorStatus, anchorRole, memberRole }));
    return out;
  }

  /** Every membership set: solo row (absent or any variant) × 0, 1 or 2 team rows. */
  function* sets(): Generator<ActiveMembershipFacts[]> {
    for (const memberRole of ROLES) {
      const solos: (ActiveMembershipFacts | null)[] = [null, ...variants(ACTOR, memberRole)];
      const teamA = variants(TEAM_ANCHOR, memberRole);
      const teamB = variants(OTHER_ANCHOR, memberRole);
      for (const solo of solos) {
        const base = solo ? [solo] : [];
        yield base;
        for (const a of teamA) {
          yield [...base, a];
          yield [a, ...base];
          for (const b of teamB) yield [...base, a, b];
        }
      }
    }
  }

  const all = [...sets()];

  it("the generated space is non-trivial (a guard against a vacuous property)", () => {
    expect(all.length).toBeGreaterThan(1000);
    const resolvedToTeam = all.filter((rows) => {
      const c = chooseActingOrg(rows, ACTOR, "on");
      return c.kind === "resolved" && c.scope.tenantKey !== ACTOR;
    });
    expect(resolvedToTeam.length).toBeGreaterThan(10);
  });

  it("off and shadow key EVERY set to the actor", () => {
    for (const rows of all)
      for (const mode of ["off", "shadow"] as const) {
        const c = chooseActingOrg(rows, ACTOR, mode);
        expect(c.kind === "resolved" && c.scope.tenantKey).toBe(ACTOR);
      }
  });

  it("on keys a payer to someone else ONLY when they hold exactly one team membership — that team's anchor", () => {
    for (const rows of all) {
      const c = chooseActingOrg(rows, ACTOR, "on");
      if (c.kind !== "resolved" || c.scope.tenantKey === ACTOR) continue;
      const team = rows.filter((r) => r.anchorPayerId !== ACTOR);
      expect(team).toHaveLength(1);
      expect(c.scope.tenantKey).toBe(team[0]!.anchorPayerId);
      expect(c.scope.orgId).toBe(team[0]!.orgId);
    }
  });

  it("on keeps every payer who is NOT a team member keyed to themselves (live solo org)", () => {
    for (const rows of all) {
      const team = rows.filter((r) => r.anchorPayerId !== ACTOR);
      const solo = rows.find((r) => r.anchorPayerId === ACTOR);
      if (team.length > 0 || !solo || solo.orgStatus !== "active") continue;
      const c = chooseActingOrg(rows, ACTOR, "on");
      expect(c).toEqual({
        kind: "resolved",
        scope: {
          actorPayerId: ACTOR,
          tenantKey: ACTOR,
          orgId: solo.orgId,
          orgRole: "owner",
          mode: "on",
        },
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The service: the mode, the R4 heal, R7, shadow logging, and the two entry points.
// ---------------------------------------------------------------------------------------------

function makeService(
  mode: PayerOrgTenancyMode,
  reads: (ActiveMembershipFacts[] | Error)[] = [[SOLO]],
) {
  const queue = [...reads];
  const orgs = {
    listActiveMembershipsWithAnchor: vi.fn(async (_payerId: string) => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return next;
    }),
    ensureSoloOrg: vi.fn(async (_payerId: string) => ({
      orgId: SOLO.orgId,
      orgRole: "owner" as const,
    })),
  };
  const svc = new PayerTenantScopeService(
    { PAYER_ORG_TENANCY_MODE: mode } as unknown as ServerConfig,
    orgs as unknown as PayerOrgsRepository,
  );
  return { svc, orgs };
}

describe("PayerTenantScopeService — off", () => {
  it("resolve keys the actor and reports the most recent org", async () => {
    const { svc } = makeService("off", [[SOLO, TEAM]]);
    await expect(svc.resolve(ACTOR)).resolves.toEqual({
      actorPayerId: ACTOR,
      tenantKey: ACTOR,
      orgId: TEAM.orgId,
      orgRole: "recruiter",
      mode: "off",
    });
  });

  it("resolve NEVER fails a request: a membership read error still keys the actor", async () => {
    const { svc, orgs } = makeService("off", [new Error("pg blip")]);
    await expect(svc.resolve(ACTOR)).resolves.toEqual({
      actorPayerId: ACTOR,
      tenantKey: ACTOR,
      orgId: null,
      orgRole: null,
      mode: "off",
    });
    expect(orgs.ensureSoloOrg).not.toHaveBeenCalled();
  });

  it("resolveActingOrg returns the most recent org, or null with none — and never heals", async () => {
    await expect(makeService("off", [[SOLO, TEAM]]).svc.resolveActingOrg(ACTOR)).resolves.toEqual({
      orgId: TEAM.orgId,
      orgRole: "recruiter",
    });
    const none = makeService("off", [[]]);
    await expect(none.svc.resolveActingOrg(ACTOR)).resolves.toBeNull();
    expect(none.orgs.ensureSoloOrg).not.toHaveBeenCalled();
  });

  it("resolveActingOrg lets a read error PROPAGATE (each caller keeps its own handling)", async () => {
    await expect(
      makeService("off", [new Error("pg blip")]).svc.resolveActingOrg(ACTOR),
    ).rejects.toThrow("pg blip");
  });
});

describe("PayerTenantScopeService — shadow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves exactly what off serves, and logs what on would decide (ids only)", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { svc, orgs } = makeService("shadow", [[SOLO, TEAM]]);
    const scope = await svc.resolve(ACTOR);
    expect(scope).toEqual({
      actorPayerId: ACTOR,
      tenantKey: ACTOR,
      orgId: TEAM.orgId,
      orgRole: "recruiter",
      mode: "shadow",
    });
    // ONE read serves both the answer and the shadow decision.
    expect(orgs.listActiveMembershipsWithAnchor).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).toMatch(
      new RegExp(
        `^payer tenancy shadow: actor=${ACTOR} would_key=${TEAM_ANCHOR} would_differ=true outcome=resolved ms=\\d+$`,
      ),
    );
  });

  it("logs would_differ=false for a solo payer", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await makeService("shadow", [[SOLO]]).svc.resolveActingOrg(ACTOR);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(
      `would_key=${ACTOR} would_differ=false outcome=resolved`,
    );
  });

  it("logs a would-be denial by reason, and still serves the actor", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { svc } = makeService("shadow", [[TEAM, m(OTHER_ANCHOR)]]);
    await expect(svc.resolve(ACTOR)).resolves.toMatchObject({ tenantKey: ACTOR, mode: "shadow" });
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(
      "would_key=- would_differ=false outcome=multiple_team_memberships",
    );
  });

  it("NEVER heals: a payer with no membership logs would_heal and writes nothing", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { svc, orgs } = makeService("shadow", [[]]);
    await expect(svc.resolveActingOrg(ACTOR)).resolves.toBeNull();
    expect(orgs.ensureSoloOrg).not.toHaveBeenCalled();
    expect(String(log.mock.calls.at(-1)?.[0])).toContain("outcome=would_heal");
  });
});

describe("PayerTenantScopeService — on", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolve keys a team member to the team's anchor (R2)", async () => {
    await expect(makeService("on", [[SOLO, TEAM]]).svc.resolve(ACTOR)).resolves.toEqual({
      actorPayerId: ACTOR,
      tenantKey: TEAM_ANCHOR,
      orgId: TEAM.orgId,
      orgRole: "recruiter",
      mode: "on",
    });
  });

  it("R4: no membership → ensureSoloOrg ONCE, then the re-read decides", async () => {
    const { svc, orgs } = makeService("on", [[], [SOLO]]);
    await expect(svc.resolve(ACTOR)).resolves.toMatchObject({
      tenantKey: ACTOR,
      orgId: SOLO.orgId,
    });
    expect(orgs.ensureSoloOrg).toHaveBeenCalledExactlyOnceWith(ACTOR);
    expect(orgs.listActiveMembershipsWithAnchor).toHaveBeenCalledTimes(2);
  });

  it("R4: still nothing after the heal → 403, and the heal is not retried", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, orgs } = makeService("on", [[]]);
    await expect(svc.resolve(ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(orgs.ensureSoloOrg).toHaveBeenCalledTimes(1);
  });

  it("every denial is the SAME neutral 403 (no rule-name oracle)", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const denials: ActiveMembershipFacts[][] = [
      [TEAM, m(OTHER_ANCHOR)], // R3
      [m(TEAM_ANCHOR, { orgStatus: "suspended" })], // R5
      [m(TEAM_ANCHOR, { anchorStatus: "suspended" })], // R5 / O-6
      [m(TEAM_ANCHOR, { anchorRole: "agent" })], // R6
      [], // R4 after the heal
    ];
    for (const rows of denials) {
      const err = await makeService("on", [rows])
        .svc.resolve(ACTOR)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).message).toBe(TENANCY_DENIED_MESSAGE);
    }
  });

  it("R3 is an ERROR log (an invariant breach); the others are warnings", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await makeService("on", [[TEAM, m(OTHER_ANCHOR)]])
      .svc.resolve(ACTOR)
      .catch(() => undefined);
    expect(String(error.mock.calls.at(-1)?.[0])).toBe(
      `payer tenancy denied: reason=multiple_team_memberships actor=${ACTOR}`,
    );
    await makeService("on", [[m(TEAM_ANCHOR, { anchorRole: "agent" })]])
      .svc.resolve(ACTOR)
      .catch(() => undefined);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      `payer tenancy denied: reason=role_mismatch actor=${ACTOR}`,
    );
  });

  it("R7: a resolve ERROR is a 403, never an allow", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const err = await makeService("on", [new Error("pg blip")])
      .svc.resolve(ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe(TENANCY_DENIED_MESSAGE);
  });

  it("resolveActingOrg: the team org on R2, null on a denial, and a read error propagates", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(makeService("on", [[SOLO, TEAM]]).svc.resolveActingOrg(ACTOR)).resolves.toEqual({
      orgId: TEAM.orgId,
      orgRole: "recruiter",
    });
    await expect(
      makeService("on", [[m(TEAM_ANCHOR, { orgStatus: "suspended" })]]).svc.resolveActingOrg(ACTOR),
    ).resolves.toBeNull();
    await expect(
      makeService("on", [new Error("pg blip")]).svc.resolveActingOrg(ACTOR),
    ).rejects.toThrow("pg blip");
  });
});

describe("ONE choice: the Team page guard, the session claim and GET /payer/me agree (ADR-0053 §3.2)", () => {
  // A member who joined a team BEFORE their solo row's accepted_at (backfill order): recency
  // (off) picks the solo org, R2 (on) picks the team. Every caller must follow the mode.
  const olderTeam = m(TEAM_ANCHOR, { acceptedAt: new Date("2026-01-01T00:00:00.000Z") });
  const newerSolo = m(ACTOR, { acceptedAt: new Date("2026-09-01T00:00:00.000Z") });

  async function choicesUnder(mode: PayerOrgTenancyMode) {
    const { svc } = makeService(mode, [[newerSolo, olderTeam]]);

    const req: Record<string, unknown> = { payer: { id: ACTOR, sid: "s", role: "employer" } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as never;
    await new PayerOrgRoleGuard(new Reflector(), svc).canActivate(ctx);

    const claim = await resolveSessionOrgClaim(svc, ACTOR);

    const payers = {
      findById: vi.fn(async () => ({ id: ACTOR })),
      decryptContact: vi.fn(() => ({
        id: ACTOR,
        role: "employer",
        status: "active",
        email: "owner@self.example",
        orgName: "Org",
        phone: null,
      })),
    } as unknown as PayersRepository;
    const me = await new PayerAccountService(payers, {} as never, svc).getOwnAccount(ACTOR);

    return { guard: req.payerOrg, claim, me: { orgId: me.orgId, orgRole: me.orgRole } };
  }

  it.each<PayerOrgTenancyMode>(["off", "shadow"])(
    "%s: all three report the most recent org",
    async (mode) => {
      vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
      const solo = { orgId: newerSolo.orgId, orgRole: "owner" };
      expect(await choicesUnder(mode)).toEqual({ guard: solo, claim: solo, me: solo });
      vi.restoreAllMocks();
    },
  );

  it("on: all three report the TEAM org (R2), as the tenant scope does", async () => {
    const team = { orgId: olderTeam.orgId, orgRole: "recruiter" };
    expect(await choicesUnder("on")).toEqual({ guard: team, claim: team, me: team });
  });
});

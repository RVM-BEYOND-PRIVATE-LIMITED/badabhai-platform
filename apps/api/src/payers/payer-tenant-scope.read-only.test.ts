import { describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "@badabhai/config";
import type { ActiveMembershipFacts } from "./payer-tenant-scope";
import type { PayerOrgsRepository } from "./payer-orgs.repository";
import { PayerTenantScopeService } from "./payer-tenant-scope.service";

/**
 * #2746 PR 5 security review L1 — `resolveReadOnly`: the tenant key of a STORED payer for a service
 * caller (Campus), from the same decision as `resolve`, but it never heals and never creates a solo
 * org. The repository is faked so every write it could make is observable.
 */

const ANCHOR = "aaaaaaaa-0000-4000-8000-0000000000aa";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000001";

function membership(
  anchor: string,
  actor: string,
  over: Partial<ActiveMembershipFacts> = {},
): ActiveMembershipFacts {
  return {
    orgId: `org-of-${anchor}`,
    orgRole: anchor === actor ? "owner" : "recruiter",
    acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    orgStatus: "active",
    anchorPayerId: anchor,
    anchorRole: "employer",
    anchorStatus: "active",
    memberRole: "employer",
    ...over,
  };
}

function make(
  mode: "off" | "shadow" | "on",
  memberships: ActiveMembershipFacts[] | Error = [],
): { svc: PayerTenantScopeService; orgs: { ensureSoloOrg: ReturnType<typeof vi.fn> } } {
  const orgs = {
    listActiveMembershipsWithAnchor: vi.fn(async () => {
      if (memberships instanceof Error) throw memberships;
      return memberships;
    }),
    ensureSoloOrg: vi.fn(async () => undefined),
  };
  const config = loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: mode });
  return {
    svc: new PayerTenantScopeService(config, orgs as unknown as PayerOrgsRepository),
    orgs,
  };
}

describe("PayerTenantScopeService.resolveReadOnly (#2746 PR 5)", () => {
  it("mode on, a payer with no membership: null, and NOTHING is written (resolve would heal)", async () => {
    const readOnly = make("on", []);
    expect(await readOnly.svc.resolveReadOnly(ANCHOR)).toBeNull();
    expect(readOnly.orgs.ensureSoloOrg).not.toHaveBeenCalled();

    // The contrast that makes this method necessary: the request path heals the same payer.
    const healing = make("on", []);
    await healing.svc.resolve(ANCHOR).catch(() => undefined);
    expect(healing.orgs.ensureSoloOrg).toHaveBeenCalledWith(ANCHOR);
  });

  it("mode on: the same tenant key resolve gives (a team member keys to the anchor)", async () => {
    const { svc, orgs } = make("on", [membership(MEMBER, MEMBER), membership(ANCHOR, MEMBER)]);
    const scope = await svc.resolveReadOnly(MEMBER);
    expect(scope?.tenantKey).toBe(ANCHOR);
    expect(orgs.ensureSoloOrg).not.toHaveBeenCalled();
  });

  it("mode on: a tenancy denial is null, not a 403", async () => {
    const { svc } = make("on", [membership(ANCHOR, ANCHOR, { orgStatus: "suspended" })]);
    expect(await svc.resolveReadOnly(ANCHOR)).toBeNull();
  });

  it("mode on: a read failure propagates", async () => {
    const { svc } = make("on", new Error("db down"));
    await expect(svc.resolveReadOnly(ANCHOR)).rejects.toThrow("db down");
  });

  it.each(["off", "shadow"] as const)(
    "mode %s: the payer is its own tenant, as resolve says, with no write",
    async (mode) => {
      const { svc, orgs } = make(mode, []);
      expect((await svc.resolveReadOnly(MEMBER))?.tenantKey).toBe(MEMBER);
      expect(orgs.ensureSoloOrg).not.toHaveBeenCalled();
    },
  );
});

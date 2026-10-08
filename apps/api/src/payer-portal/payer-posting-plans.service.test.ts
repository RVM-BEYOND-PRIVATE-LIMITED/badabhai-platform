import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { defaultModeResolver, resolverOver } from "../payers/payer-tenant-scope.test-support";
import { PayerPostingPlansService } from "./payer-posting-plans.service";

/**
 * ADR-0053 (PAY-DB-01) P2c — the payer posting surface's ONE seam onto plans, boosts and quota
 * top-ups (the "split purchase" hazard of PR #2167's review, plan §3.1) and the stats of the
 * posting reads (the "N+1" hazard).
 *
 * The REAL resolver over an in-memory membership table. The posting chokepoint below honours the
 * scope it is handed exactly as `JobPostingsService.getOneInScope` / `listInScope` do (the
 * repository's `payer_id = $tenant`); `PostingPlansService` is a recorder, so what each test
 * asserts is WHICH scope reached it.
 */

const ANCHOR = "aaaaaaaa-0000-4000-8000-00000000000a";
const MEMBER = "bbbbbbbb-0000-4000-8000-00000000000b";
const OUTSIDER = "cccccccc-0000-4000-8000-00000000000c";
const TEAM = [{ anchor: ANCHOR, members: [MEMBER] }];
const ON = { PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig;
const POSTING = "dddddddd-0000-4000-8000-00000000000d";
const OTHER = "eeeeeeee-0000-4000-8000-00000000000e";
const CTX: RequestContext = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "r" };
const NOT_FOUND = "Job posting not found";
const STATS = {
  plan_tier: "standard" as const,
  applicant_visibility_quota: 10,
  applicants_viewed_count: 2,
  boosted: false,
};

/** The ANCHOR owns POSTING and OTHER; nobody else owns anything. */
function make(tenancy: PayerTenantScopeService) {
  const ownedBy = (scope: PayerTenantScope) => scope.tenantKey === ANCHOR;
  const jobPostings = {
    getOneInScope: vi.fn(async (id: string, scope: PayerTenantScope) => {
      if (!ownedBy(scope) || ![POSTING, OTHER].includes(id)) {
        throw new NotFoundException(NOT_FOUND);
      }
      return { id, payer_id: ANCHOR };
    }),
    listInScope: vi.fn(async (scope: PayerTenantScope, _query: unknown) =>
      ownedBy(scope) ? [{ id: POSTING }, { id: OTHER }] : [],
    ),
  };
  type Purchase = (id: string, scope: PayerTenantScope, dto: unknown, ctx: unknown) => Promise<unknown>;
  const plans = {
    buyPlanInScope: vi.fn<Purchase>(async () => ({ plan: { id: "plan-1" } })),
    buyBoostInScope: vi.fn<Purchase>(async () => ({ boost: { id: "boost-1" } })),
    topUpQuotaInScope: vi.fn<Purchase>(async () => ({ plan: { id: "plan-1" } })),
    getPostingStats: vi.fn(async (_id: string, _tenant: string) => STATS),
  };
  // ADR-0053 P2b — the résumé-download counts ride the same scope as the stats (M-3): the page
  // in ONE grouped read, the single posting in one count. POSTING has 3 downloads, OTHER none.
  const disclosures = {
    countDownloadsInScope: vi.fn(
      async (ids: readonly string[], _scope: PayerTenantScope) =>
        new Map(ids.map((id) => [id, id === POSTING ? 3 : 0])),
    ),
    countDownloadsForPostingInScope: vi.fn(
      async (_id: string, _scope: PayerTenantScope) => 7,
    ),
  };
  const svc = new PayerPostingPlansService(
    jobPostings as never,
    plans as never,
    disclosures as never,
    tenancy,
  );
  return { svc, jobPostings, plans, disclosures, resolve: vi.spyOn(tenancy, "resolve") };
}

/** The scope a recorder was called with, by argument position. */
const scopeArg = (fn: ReturnType<typeof vi.fn>, call = 0, index = 1): PayerTenantScope =>
  fn.mock.calls[call]![index] as PayerTenantScope;

describe("PayerPostingPlansService.forOwnedPosting — resolve once; ownership and purchase in ONE scope", () => {
  it("on: a teammate's plan, boost and top-up on the org's posting all run in the scope the ownership check passed in", async () => {
    const d = make(resolverOver(ON, TEAM));
    const owned = await d.svc.forOwnedPosting(POSTING, MEMBER);
    await owned.buyPlan({ tier: "standard" }, CTX);
    await owned.buyBoost({ tier: "boost_7" }, CTX);
    await owned.topUpQuota({ tier: "topup_10" }, CTX);

    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect(d.resolve).toHaveBeenCalledWith(MEMBER);
    const checked = scopeArg(d.jobPostings.getOneInScope);
    expect(checked).toMatchObject({ actorPayerId: MEMBER, tenantKey: ANCHOR });
    // The very object the ownership check used — not a re-resolution that happens to agree.
    for (const purchase of [d.plans.buyPlanInScope, d.plans.buyBoostInScope, d.plans.topUpQuotaInScope]) {
      expect(purchase).toHaveBeenCalledTimes(1);
      expect(purchase.mock.calls[0]![0]).toBe(POSTING);
      expect(scopeArg(purchase)).toBe(checked);
    }
    expect(d.plans.buyPlanInScope).toHaveBeenCalledWith(POSTING, checked, { tier: "standard" }, CTX);
  });

  it("on: an outsider gets the SAME neutral 404 as for an unknown id, and no purchase is reachable", async () => {
    const d = make(resolverOver(ON, TEAM));
    const foreign = await d.svc.forOwnedPosting(POSTING, OUTSIDER).catch((e: unknown) => e);
    const unknown = await d.svc.forOwnedPosting("ffffffff-0000-4000-8000-00000000000f", OUTSIDER).catch(
      (e: unknown) => e,
    );
    expect(foreign).toBeInstanceOf(NotFoundException);
    expect((foreign as NotFoundException).getResponse()).toEqual(
      (unknown as NotFoundException).getResponse(),
    );
    for (const purchase of Object.values(d.plans)) expect(purchase).not.toHaveBeenCalled();
  });

  it("the handle is bound to ITS posting: two handles never cross", async () => {
    const d = make(resolverOver(ON, TEAM));
    const first = await d.svc.forOwnedPosting(POSTING, MEMBER);
    const second = await d.svc.forOwnedPosting(OTHER, MEMBER);
    await second.buyPlan({ tier: "pro" }, CTX);
    await first.buyBoost({ tier: "boost_7" }, CTX);
    expect(d.plans.buyPlanInScope.mock.calls[0]![0]).toBe(OTHER);
    expect(d.plans.buyBoostInScope.mock.calls[0]![0]).toBe(POSTING);
  });

  it("off (the default): the teammate is their own tenant — the anchor's posting is the same 404 as today", async () => {
    const d = make(defaultModeResolver(TEAM));
    await expect(d.svc.forOwnedPosting(POSTING, MEMBER)).rejects.toBeInstanceOf(NotFoundException);
    expect(scopeArg(d.jobPostings.getOneInScope)).toMatchObject({
      actorPayerId: MEMBER,
      tenantKey: MEMBER,
    });
    // The anchor is their own tenant in both modes (solo identity).
    const owned = await d.svc.forOwnedPosting(POSTING, ANCHOR);
    await owned.buyPlan({ tier: "standard" }, CTX);
    expect(scopeArg(d.plans.buyPlanInScope)).toMatchObject({ actorPayerId: ANCHOR, tenantKey: ANCHOR });
  });
});

describe("PayerPostingPlansService — the posting reads carry their stats from ONE resolution (§5.4)", () => {
  it("on: a teammate's list is the org's postings, each with stats read under the anchor's key; one resolution for N postings", async () => {
    const d = make(resolverOver(ON, TEAM));
    const rows = await d.svc.listWithStats(MEMBER, { status: "open" });
    expect(rows.map((r) => r.posting.id)).toEqual([POSTING, OTHER]);
    expect(rows.every((r) => r.stats === STATS)).toBe(true);
    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect(d.jobPostings.listInScope).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: ANCHOR }),
      { status: "open" },
    );
    expect(d.plans.getPostingStats.mock.calls).toEqual([
      [POSTING, ANCHOR],
      [OTHER, ANCHOR],
    ]);
    // P2b (M-3): the page's download counts are ONE grouped read in the SAME scope object.
    expect(rows.map((r) => r.disclosuresCount)).toEqual([3, 0]);
    expect(d.disclosures.countDownloadsInScope).toHaveBeenCalledTimes(1);
    expect(d.disclosures.countDownloadsInScope.mock.calls[0]![0]).toEqual([POSTING, OTHER]);
    expect(d.disclosures.countDownloadsInScope.mock.calls[0]![1]).toBe(
      scopeArg(d.jobPostings.listInScope, 0, 0),
    );
    expect(d.disclosures.countDownloadsForPostingInScope).not.toHaveBeenCalled();
  });

  it("on: a teammate's read of the org's posting carries its stats; an outsider's is the 404 and reads no stats", async () => {
    const d = make(resolverOver(ON, TEAM));
    await expect(d.svc.getOneWithStats(POSTING, MEMBER)).resolves.toEqual({
      posting: { id: POSTING, payer_id: ANCHOR },
      stats: STATS,
      disclosuresCount: 7,
    });
    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect(d.plans.getPostingStats).toHaveBeenCalledWith(POSTING, ANCHOR);
    // P2b (M-3): the single read's download count, in the scope the ownership read used.
    expect(d.disclosures.countDownloadsForPostingInScope).toHaveBeenCalledTimes(1);
    expect(d.disclosures.countDownloadsForPostingInScope.mock.calls[0]![0]).toBe(POSTING);
    expect(d.disclosures.countDownloadsForPostingInScope.mock.calls[0]![1]).toBe(
      scopeArg(d.jobPostings.getOneInScope),
    );

    d.plans.getPostingStats.mockClear();
    d.disclosures.countDownloadsForPostingInScope.mockClear();
    await expect(d.svc.getOneWithStats(POSTING, OUTSIDER)).rejects.toBeInstanceOf(NotFoundException);
    expect(d.plans.getPostingStats).not.toHaveBeenCalled();
    expect(d.disclosures.countDownloadsForPostingInScope).not.toHaveBeenCalled();
  });

  it("off (the default): the teammate lists their own (no) postings, keyed by themself, as today", async () => {
    const d = make(defaultModeResolver(TEAM));
    expect(await d.svc.listWithStats(MEMBER, {})).toEqual([]);
    expect(d.jobPostings.listInScope).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: MEMBER }),
      {},
    );
    expect(d.plans.getPostingStats).not.toHaveBeenCalled();
  });
});

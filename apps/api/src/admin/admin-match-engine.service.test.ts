import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import type { MatchFeedRow } from "../match/match-feed.repository";
import type { EngineFunnelCounts } from "./admin-match-engine.repository";
import {
  AdminMatchEngineService,
  explainMatch,
  shortRef,
  toFunnel,
} from "./admin-match-engine.service";

const WORKER = "5eeded00-0001-4a00-8000-000000000001";
const P1 = "bc765f2b-902f-4cba-81c2-6abab75e4bf5";
const P2 = "bc765f2b-902f-4cba-81c2-6abab75e4bf6";
const NOW = new Date("2026-10-05T10:00:00.000Z");

function feedRow(
  id: string,
  tier: 1 | 2,
  skill: string,
  over: Partial<MatchFeedRow> = {},
): MatchFeedRow {
  return {
    jobPostingId: id,
    payerKey: "payer-secret-key",
    matchTier: tier,
    matchedSkillId: skill,
    boosted: false,
    publishedAt: new Date("2026-10-01T09:00:00.000Z"),
    roleTitle: `Role ${id.slice(-1)}`,
    city: "Pune",
    area: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    description: "free text the engine view must not need",
    benefits: null,
    requirements: null,
    payMin: null,
    payMax: null,
    payType: null,
    shift: null,
    neededBy: null,
    ...over,
  };
}

const COUNTS: EngineFunnelCounts = {
  openPostings: 10,
  reachedDirect: 3,
  reachedRelated: 2,
  alreadyActioned: 1,
};

function setup(opts: { live?: boolean; page?: MatchFeedRow[] } = {}) {
  const page = opts.page ?? [
    feedRow(P2, 2, "mskill_cnc_grinding_operator"),
    feedRow(P1, 1, "mskill_cnc_turner", { boosted: true }),
  ];
  const repo = {
    findLiveWorker: vi.fn(async () => (opts.live === false ? undefined : { id: WORKER })),
    listWorkerSkills: vi.fn(async () => [
      {
        skillId: "mskill_cnc_turner",
        wants: true,
        monthsBucketed: 24,
        source: "interview" as const,
      },
    ]),
    countFunnel: vi.fn(async () => COUNTS),
    findCardPostingMeta: vi.fn(
      async () =>
        new Map([
          [P1, { roleKind: "cnc_turner", matchSkillIds: ["mskill_cnc_turner"] }],
          [P2, { roleKind: null, matchSkillIds: ["mskill_cnc_turner"] }],
        ]),
    ),
    listRecentWorkers: vi.fn(async () => [
      { workerId: WORKER, createdAt: NOW, topSkillId: "mskill_cnc_turner" },
    ]),
    findPostingHeader: vi.fn(async () => undefined as unknown),
  };
  const feed = { composePage: vi.fn(async () => page), getFeed: vi.fn() };
  const candidates = { listForPosting: vi.fn() };
  const config = { get: vi.fn(async () => DEFAULT_MATCH_CONFIG) };
  const workerSkills = { countReachForPosting: vi.fn(async () => ({ total: 7, tier1: 4 })) };
  const svc = new AdminMatchEngineService(
    repo as never,
    feed as never,
    candidates as never,
    config as never,
    workerSkills as never,
  );
  return { svc, repo, feed, candidates, workerSkills };
}

describe("AdminMatchEngineService.getWorkerView", () => {
  it("serves the feed's own page in its own order, capped at 50, through composePage (never getFeed)", async () => {
    const { svc, feed } = setup();
    const view = await svc.getWorkerView(WORKER, NOW);
    expect(feed.composePage).toHaveBeenCalledWith(WORKER, 50, {});
    expect(feed.getFeed).not.toHaveBeenCalled();
    expect(view.cards.map((c) => [c.rank, c.job_posting_id])).toEqual([
      [1, P2],
      [2, P1],
    ]);
    expect(view.card_cap).toBe(50);
    expect(view.generated_at).toBe(NOW.toISOString());
  });

  it("explains each card: direct, or related → the posted skill it hangs off", async () => {
    const { svc } = setup();
    const view = await svc.getWorkerView(WORKER, NOW);
    expect(view.cards[0]!.why).toBe("related: CNC Grinding Operator → CNC Turner");
    expect(view.cards[1]!.why).toBe("direct: CNC Turner");
    expect(view.cards[1]!.role_kind).toBe("cnc_turner");
    expect(view.cards[1]!.boosted).toBe(true);
  });

  it("projects no company key and no posting free text onto a card", async () => {
    const { svc } = setup();
    const json = JSON.stringify(await svc.getWorkerView(WORKER, NOW));
    expect(json).not.toContain("payer-secret-key");
    expect(json).not.toContain("free text");
    expect(json).not.toMatch(/full_name|phone|org_label/);
  });

  it("returns a funnel that adds up", async () => {
    const { svc } = setup();
    const { funnel } = await svc.getWorkerView(WORKER, NOW);
    expect(funnel).toEqual({
      open_postings: 10,
      reached_direct: 3,
      reached_related: 2,
      hidden: 5,
      already_actioned: 1,
    });
    expect(funnel.open_postings).toBe(
      funnel.reached_direct + funnel.reached_related + funnel.hidden,
    );
  });

  it("is a neutral 404 for an unknown or pending-deletion worker, and reads nothing else", async () => {
    const { svc, repo, feed } = setup({ live: false });
    await expect(svc.getWorkerView(WORKER, NOW)).rejects.toBeInstanceOf(NotFoundException);
    expect(feed.composePage).not.toHaveBeenCalled();
    expect(repo.countFunnel).not.toHaveBeenCalled();
    expect(repo.listWorkerSkills).not.toHaveBeenCalled();
  });
});

describe("AdminMatchEngineService.getPostingView", () => {
  it("splits the stored reach set by tier and passes the payer's ranked list through in order", async () => {
    const { svc, repo, candidates } = setup();
    repo.findPostingHeader.mockResolvedValue({
      id: P1,
      roleTitle: "CNC Turner",
      roleKind: null,
      status: "open",
      city: "Pune",
      matchSkillIds: ["mskill_cnc_turner"],
      reachSkillIds: ["mskill_cnc_turner", "mskill_cnc_grinding_operator"],
    });
    candidates.listForPosting.mockResolvedValue({
      jobId: P1,
      applicants: [
        {
          workerId: WORKER,
          applicationId: "a1",
          rank: 1,
          matchTier: 2,
          effectiveTier: 1,
          skillMonths: 30,
          industryMonths: 40,
          lastWorkedAt: null,
          matchedSkillLabel: "X",
          engineVersion: "v1",
        },
        {
          workerId: P2,
          applicationId: "a2",
          rank: 2,
          matchTier: 1,
          effectiveTier: 1,
          skillMonths: 6,
          industryMonths: 6,
          lastWorkedAt: null,
          matchedSkillLabel: null,
          engineVersion: "v1",
        },
      ],
    });
    const view = await svc.getPostingView(P1, NOW);
    expect(view.posted_skills.map((s) => s.skill_id)).toEqual(["mskill_cnc_turner"]);
    expect(view.related_skills.map((s) => s.skill_id)).toEqual(["mskill_cnc_grinding_operator"]);
    expect(view.reach).toEqual({ total: 7, tier1: 4, tier2: 3 });
    expect(view.candidates.map((c) => c.application_id)).toEqual(["a1", "a2"]);
    expect(view.candidates[0]!.short_ref).toBe(shortRef(WORKER));
    expect(view.tier_floor_months).toBe(DEFAULT_MATCH_CONFIG.tierFloorMonths);
  });

  it("is a neutral 404 for an unknown posting", async () => {
    const { svc, candidates } = setup();
    await expect(svc.getPostingView(P1, NOW)).rejects.toBeInstanceOf(NotFoundException);
    expect(candidates.listForPosting).not.toHaveBeenCalled();
  });
});

describe("pure helpers", () => {
  it("shortRef is the first 8 hex chars", () => {
    expect(shortRef(WORKER)).toBe("5eeded00");
  });

  it("toFunnel never reports a negative hidden count", () => {
    expect(
      toFunnel({ openPostings: 1, reachedDirect: 2, reachedRelated: 0, alreadyActioned: 0 }).hidden,
    ).toBe(0);
  });

  it("explainMatch names every posted skill when a widen put the skill outside the curated map", () => {
    expect(explainMatch(2, "mskill_cnc_turner", ["mskill_cnc_turner"])).toMatch(
      /^related: CNC Turner → /,
    );
    expect(explainMatch(2, "mskill_unknown", [])).toBe("related: mskill_unknown → posted skill");
  });
});

describe("AdminMatchEngineService.listRecentWorkers", () => {
  it("serves opaque refs with a trade hint and nothing else", async () => {
    const { svc } = setup();
    const { workers } = await svc.listRecentWorkers(20);
    expect(workers).toEqual([
      {
        worker_id: WORKER,
        short_ref: "5eeded00",
        created_at: NOW.toISOString(),
        trade_label: "CNC Turner",
      },
    ]);
  });
});

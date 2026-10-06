import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("./admin-http", () => ({
  adminFetch: async (path: string) => {
    calls.paths.push(path);
    return {};
  },
}));

const {
  engineRecentWorkersSchema,
  engineWorkerSchema,
  enginePostingSchema,
  getEnginePosting,
  getEngineWorker,
  listEngineWorkers,
} = await import("./match-engine");

const WORKER = {
  worker_id: "5eeded00-0001-4a00-8000-000000000001",
  short_ref: "5eeded00",
  skills: [
    {
      skill_id: "mskill_cnc_turning",
      label: "CNC Turning",
      wants: true,
      months_bucketed: 24,
      source: "interview",
    },
  ],
  funnel: {
    open_postings: 4,
    reached_direct: 1,
    reached_related: 1,
    hidden: 2,
    already_actioned: 0,
  },
  cards: [
    {
      rank: 1,
      job_posting_id: "bc765f2b-902f-4cba-81c2-6abab75e4bf5",
      role_title: "CNC Operator",
      role_kind: "cnc_turner",
      city: "Pune",
      match_tier: 1,
      matched_skill_id: "mskill_cnc_turning",
      matched_skill_label: "CNC Turning",
      boosted: false,
      published_at: "2026-10-01T09:00:00.000Z",
      why: "direct: CNC Turning",
    },
  ],
  card_cap: 50,
  generated_at: "2026-10-05T10:00:00.000Z",
};

beforeEach(() => {
  calls.paths = [];
});

describe("engine schemas", () => {
  it("parse the three API responses", () => {
    expect(engineWorkerSchema.parse(WORKER).cards[0]!.why).toBe("direct: CNC Turning");
    expect(
      engineRecentWorkersSchema.parse({
        workers: [
          {
            worker_id: WORKER.worker_id,
            short_ref: "5eeded00",
            created_at: "2026-10-01T00:00:00Z",
            trade_label: null,
          },
        ],
      }).workers,
    ).toHaveLength(1);
    expect(
      enginePostingSchema.parse({
        job_posting_id: WORKER.cards[0]!.job_posting_id,
        role_title: "CNC Operator",
        role_kind: null,
        status: "open",
        city: null,
        posted_skills: [{ skill_id: "mskill_cnc_turning", label: "CNC Turning" }],
        related_skills: [],
        reach: { total: 3, tier1: 2, tier2: 1 },
        candidates: [],
        tier_floor_months: 24,
        generated_at: "2026-10-05T10:00:00.000Z",
      }).reach.tier2,
    ).toBe(1);
  });

  it("rejects a drifted shape rather than rendering undefined", () => {
    expect(() => engineWorkerSchema.parse({ ...WORKER, funnel: { open_postings: 4 } })).toThrow();
  });
});

describe("engine readers", () => {
  it("call exactly the three gated API routes, clamped and encoded", async () => {
    await listEngineWorkers(500);
    await listEngineWorkers(0);
    await getEngineWorker("a/b");
    await getEnginePosting("p-1");
    expect(calls.paths).toEqual([
      "/admin/match/engine/workers?recent=50",
      "/admin/match/engine/workers?recent=1",
      "/admin/match/engine/workers/a%2Fb",
      "/admin/match/engine/postings/p-1",
    ]);
  });
});

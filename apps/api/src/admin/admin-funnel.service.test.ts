import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { AdminFunnelService } from "./admin-funnel.service";

/**
 * B14 (#2568) — the funnel composition: per-worker statuses into counts, stops and
 * k-anon'd splits.
 *
 * WHAT MAKES THIS SUITE NECESSARY RATHER THAN NICE. The composition is pure JS over
 * repository Maps — a swapped share, a missing `unknown` bucket, or a k-anon floor
 * applied to the headline instead of the cells would produce EXACTLY the same behaviour
 * as the working code from every caller's point of view: a 200 with numbers that are
 * quietly wrong, or quietly identifying. The guard has to be direct. (That the RULES
 * themselves match the per-worker journey is the parity db gate's job, not this file's:
 * these tests drive `workerStatuses` with hand-built Maps and assert the arithmetic.)
 */

const UNI = { packId: "qp_universal", packVersion: 3 };

function make(
  opts: {
    cohort?: Array<{ id: string; city: string | null; language: string | null; hasPhoto: boolean }>;
    stamped?: Map<string, Array<{ packId: string; packVersion: number }>>;
    items?: Map<string, string[]>;
    settled?: Map<string, string[]>;
    prefilled?: Set<string>;
    resumes?: Set<string>;
    profiles?: Map<string, string | null>;
    apps?: Map<string, { applied: number; skipped: number }>;
    search?: Array<{ workerId: string; eventName: string; n: number }>;
    kit?: Array<{ workerId: string; n: number }>;
    trades?: Map<string, string>;
    appVersions?: Map<string, string | null>;
  } = {},
) {
  const cohort = opts.cohort ?? [];
  const repo = {
    listCohort: vi.fn(async () => cohort),
    primaryTradeByWorker: vi.fn(async () => opts.trades ?? new Map()),
    appVersionByWorker: vi.fn(async () => opts.appVersions ?? new Map()),
    stampedPairsByWorker: vi.fn(async () => opts.stamped ?? new Map()),
    itemKeysByPair: vi.fn(async () => opts.items ?? new Map()),
    settledKeysByWorker: vi.fn(async () => opts.settled ?? new Map()),
    prefilledCityWorkers: vi.fn(async () => opts.prefilled ?? new Set()),
    resumeFlags: vi.fn(async () => opts.resumes ?? new Set()),
    profileStatuses: vi.fn(async () => opts.profiles ?? new Map()),
    applicationFlags: vi.fn(async () => opts.apps ?? new Map()),
  };
  const eventsRepo = {
    workerSubjectEventCounts: vi.fn(async () => opts.search ?? []),
    interviewKitDownloadsForWorkers: vi.fn(async () => opts.kit ?? []),
  };
  const journeyRepo = {
    findActiveUniversalPack: vi.fn(async () => UNI),
  };
  const config = { PROFILING_PACK_LOCALE: "hi" } as never;
  const svc = new AdminFunnelService(
    repo as never,
    eventsRepo as never,
    journeyRepo as never,
    config,
  );
  return { svc, repo, eventsRepo };
}

const W = (id: string, over: Partial<{ city: string | null; hasPhoto: boolean }> = {}) => ({
  id,
  city: over.city ?? null,
  language: "hi" as string | null,
  hasPhoto: over.hasPhoto ?? false,
});

describe("AdminFunnelService.onboardingFunnel — counts, stops and splits", () => {
  it("an empty cohort is zeros everywhere, never nulls", async () => {
    const { svc } = make({ cohort: [] });
    const res = await svc.onboardingFunnel({ testAccounts: "exclude" });

    expect(res.total_workers).toBe(0);
    expect(res.steps).toHaveLength(7);
    for (const s of res.steps) expect(s).toMatchObject({ done: 0, in_progress: 0, not_done: 0 });
    // All seven stop keys + completed ride along even when empty — a missing bucket
    // and a zero bucket look identical to a client and mean different things.
    expect(res.stopped_at).toHaveLength(8);
    expect(res.stopped_at.find((b) => b.key === "completed")).toEqual({
      key: "completed",
      count: 0,
    });
    for (const dim of ["trade", "city", "language", "app_version"] as const) {
      expect(res.splits[dim]).toEqual([]);
    }
  });

  it("stopped_at names the first non-done step; all-done workers complete", async () => {
    const { svc } = make({
      cohort: [W("w1"), W("w2")],
      settled: new Map([["w2", ["q1"]]]),
      items: new Map([
        ["qp_welding:1", ["q1"]],
        ["qp_universal:3", ["u1"]],
      ]),
      stamped: new Map([["w2", [{ packId: "qp_welding", packVersion: 1 }]]]),
      resumes: new Set(["w2"]),
      profiles: new Map([["w2", "confirmed"]]),
      apps: new Map([["w2", { applied: 1, skipped: 0 }]]),
    });
    // w1: nothing → stopped at profiling. w2: profiling in_progress (q1 of qp_welding:1
    // + universal u1 unsettled → 1/2) → stopped at profiling too.
    const res = await svc.onboardingFunnel({ testAccounts: "exclude" });

    expect(res.total_workers).toBe(2);
    const profiling = res.steps.find((s) => s.key === "profiling")!;
    expect(profiling).toMatchObject({ done: 0, in_progress: 1, not_done: 1 });
    const stop = Object.fromEntries(res.stopped_at.map((b) => [b.key, b.count]));
    expect(stop.profiling).toBe(2);
    expect(stop.completed).toBe(0);
  });

  it("split cells below the k-anon floor report nothing (suppressed, not zeroed)", async () => {
    const cohort = [
      W("w1", { city: "Pune" }),
      W("w2", { city: "Pune" }),
      W("w3", { city: "Delhi" }),
    ];
    const { svc } = make({ cohort });
    const res = await svc.onboardingFunnel({ testAccounts: "exclude" });

    const pune = res.splits.city.find((c) => c.value === "Pune")!;
    const delhi = res.splits.city.find((c) => c.value === "Delhi")!;
    expect(pune).toMatchObject({ total: 0, suppressed: true, stopped_at: [] });
    expect(delhi).toMatchObject({ total: 0, suppressed: true, stopped_at: [] });
  });

  it("split cells at/above the floor carry the stopped distribution", async () => {
    const cohort = Array.from({ length: 6 }, (_, i) => W(`w${i}`, { city: "Pune" }));
    const { svc } = make({
      cohort,
      resumes: new Set(cohort.map((w) => w.id)),
      profiles: new Map(cohort.map((w) => [w.id, "extracted"])),
    });
    const res = await svc.onboardingFunnel({ testAccounts: "exclude" });

    const pune = res.splits.city.find((c) => c.value === "Pune")!;
    expect(pune).toMatchObject({ total: 6, suppressed: false });
    const stop = Object.fromEntries(pune.stopped_at.map((b) => [b.key, b.count]));
    // Profiling never started (no answers) → all six held at profiling.
    expect(stop.profiling).toBe(6);
  });

  it("missing dimensions bucket into unknown, never dropped", async () => {
    const cohort = Array.from({ length: 5 }, (_, i) => W(`w${i}`));
    const { svc } = make({ cohort });
    const res = await svc.onboardingFunnel({ testAccounts: "exclude" });

    expect(res.splits.trade.find((c) => c.value === "unknown")).toMatchObject({ total: 5 });
    expect(res.splits.city.find((c) => c.value === "unknown")).toMatchObject({ total: 5 });
    expect(res.splits.language.find((c) => c.value === "hi")).toMatchObject({ total: 5 });
    expect(res.splits.app_version.find((c) => c.value === "unknown")).toMatchObject({ total: 5 });
  });

  it("open vocabularies cap at 100 values + an other bucket", async () => {
    const cohort = Array.from({ length: 101 * 5 }, (_, i) =>
      W(`w${i}`, { city: `City${Math.floor(i / 5)}` }),
    );
    const { svc } = make({ cohort });
    const res = await svc.onboardingFunnel({ testAccounts: "exclude" });

    expect(res.splits.city).toHaveLength(101);
    const other = res.splits.city.find((c) => c.value === "other")!;
    expect(other.suppressed).toBe(false);
    expect(other.total).toBe(5);
    // Headline still covers everyone: capped cells + other == cohort.
    const inCells = res.splits.city.reduce((n, c) => n + c.total, 0);
    expect(inCells).toBe(505);
  });
});

describe("AdminFunnelService.workerStatuses — the per-worker rule restatements", () => {
  it("profiling done requires the full denominator, including the universal tail", async () => {
    const { svc } = make({
      cohort: [W("w1")],
      stamped: new Map([["w1", [{ packId: "qp_welding", packVersion: 1 }]]]),
      // qp_welding:1 owns q1; universal owns u1. Only q1 settled → 1/2 → in_progress.
      items: new Map([
        ["qp_welding:1", ["q1"]],
        ["qp_universal:3", ["u1"]],
      ]),
      settled: new Map([["w1", ["q1"]]]),
    });
    const [s] = await svc.workerStatuses([W("w1")]);
    if (!s) throw new Error("expected one status");
    expect(s.statuses.profiling).toBe("in_progress");
    expect(s.stoppedAt).toBe("profiling");
  });

  it("the city-seed credit completes an otherwise-one-short interview", async () => {
    const { svc } = make({
      cohort: [W("w1")],
      stamped: new Map([["w1", [{ packId: "qp_welding", packVersion: 1 }]]]),
      items: new Map([
        ["qp_welding:1", ["q1"]],
        ["qp_universal:3", ["current_city", "u1"]],
      ]),
      settled: new Map([["w1", ["q1", "u1"]]]),
      prefilled: new Set(["w1"]),
    });
    // owned = {q1, u1}, city seeded + owned + unsettled → credit → 3/3 → done.
    const [s] = await svc.workerStatuses([W("w1")]);
    if (!s) throw new Error("expected one status");
    expect(s.statuses.profiling).toBe("done");
  });

  it("a seeded city already settled as a row is not credited twice", async () => {
    const { svc } = make({
      cohort: [W("w1")],
      stamped: new Map([["w1", [{ packId: "qp_welding", packVersion: 1 }]]]),
      items: new Map([
        ["qp_welding:1", ["q1"]],
        ["qp_universal:3", ["current_city", "u1"]],
      ]),
      settled: new Map([["w1", ["q1", "current_city"]]]),
      prefilled: new Set(["w1"]),
    });
    // Owned settled = {q1, current_city} → 2/3 → still in_progress (u1 missing).
    const [s] = await svc.workerStatuses([W("w1")]);
    if (!s) throw new Error("expected one status");
    expect(s.statuses.profiling).toBe("in_progress");
  });

  it("profile maps confirmed/extracting/draft exactly like the per-worker page", async () => {
    const { svc } = make({
      cohort: [W("a"), W("b"), W("c"), W("d")],
      profiles: new Map([
        ["a", "confirmed"],
        ["b", "extracted"],
        ["c", "draft"],
      ]),
    });
    const statuses = await svc.workerStatuses([W("a"), W("b"), W("c"), W("d")]);
    const byId = new Map(statuses.map((s) => [s.workerId, s.statuses.profile_confirmed]));
    expect(byId.get("a")).toBe("done");
    expect(byId.get("b")).toBe("in_progress");
    expect(byId.get("c")).toBe("not_done");
    expect(byId.get("d")).toBe("not_done");
  });

  it("search/apply: applied wins, else search or skip keeps it in progress", async () => {
    const { svc } = make({
      cohort: [W("a"), W("b"), W("c"), W("d")],
      apps: new Map([
        ["a", { applied: 1, skipped: 0 }],
        ["c", { applied: 0, skipped: 2 }],
      ]),
      search: [{ workerId: "b", eventName: "job.search_performed", n: 3 }],
    });
    const statuses = await svc.workerStatuses([W("a"), W("b"), W("c"), W("d")]);
    const byId = new Map(statuses.map((s) => [s.workerId, s.statuses.job_search_apply]));
    expect(byId.get("a")).toBe("done");
    expect(byId.get("b")).toBe("in_progress");
    expect(byId.get("c")).toBe("in_progress");
    expect(byId.get("d")).toBe("not_done");
  });
});

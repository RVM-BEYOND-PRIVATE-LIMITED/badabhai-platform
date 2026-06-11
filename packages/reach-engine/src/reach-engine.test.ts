import { describe, it, expect } from "vitest";
import { scoreWorkerForJob, rankWorkersForJob, haversineKm } from "./index";
import type { JobSpec, WorkerSignals } from "./index";

// Pune ≈ (18.52, 73.86); Mumbai ≈ (19.07, 72.88) ~120km away.
const PUNE = { lat: 18.5204, lng: 73.8567 };
const MUMBAI = { lat: 19.076, lng: 72.8777 };

const JOB: JobSpec = {
  jobId: "job-1",
  roleIds: ["vmc_operator"],
  location: PUNE,
  maxTravelKm: 40,
  minExperienceYears: 3,
  maxExperienceYears: 10,
  payMin: 20000,
  payMax: 30000,
  neededBy: "immediate",
};

const STRONG: WorkerSignals = {
  workerId: "w-strong",
  roleId: "vmc_operator",
  experienceYears: 5,
  expectedSalary: 28000,
  location: PUNE,
  availability: "immediate",
  lastActiveDaysAgo: 1,
};

describe("scoreWorkerForJob", () => {
  it("scores a strong, complete match highly with a full breakdown", () => {
    const r = scoreWorkerForJob(JOB, STRONG);
    expect(r.workerId).toBe("w-strong");
    expect(r.jobId).toBe("job-1");
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.components).toHaveLength(6);
    // every component is explainable
    for (const c of r.components) expect(c.reason.length).toBeGreaterThan(0);
  });

  it("never excludes an off-trade worker — scores low, but is not absent", () => {
    const offTrade: WorkerSignals = { ...STRONG, workerId: "w-packer", roleId: "packer" };
    const r = scoreWorkerForJob(JOB, offTrade);
    expect(r.score).toBeGreaterThanOrEqual(0); // present, not thrown/excluded
    expect(r.score).toBeLessThan(scoreWorkerForJob(JOB, STRONG).score); // ranked lower
    expect(r.components.find((c) => c.signal === "role")!.raw).toBe(0);
  });

  it("works on a partial profile (only trade known) — not dropped, not zero", () => {
    const partial: WorkerSignals = { workerId: "w-thin", roleId: "vmc_operator" };
    const r = scoreWorkerForJob(JOB, partial);
    expect(r.score).toBeGreaterThan(0); // appears
    // a fuller, equally-on-trade profile ranks higher (§5 completeness)
    expect(r.score).toBeLessThan(scoreWorkerForJob(JOB, STRONG).score);
  });

  it("does not penalise a blank field harder than a confirmed-bad one", () => {
    const unknownRole: WorkerSignals = { ...STRONG, workerId: "w-unknown", roleId: null };
    const wrongRole: WorkerSignals = { ...STRONG, workerId: "w-wrong", roleId: "welder" };
    expect(scoreWorkerForJob(JOB, unknownRole).score).toBeGreaterThan(
      scoreWorkerForJob(JOB, wrongRole).score,
    );
  });

  it("is deterministic (no clock/random) — identical inputs, identical score", () => {
    expect(scoreWorkerForJob(JOB, STRONG)).toEqual(scoreWorkerForJob(JOB, STRONG));
  });

  it("haversine: Pune↔Mumbai is ~120km", () => {
    expect(Math.round(haversineKm(PUNE, MUMBAI))).toBeGreaterThan(100);
    expect(Math.round(haversineKm(PUNE, MUMBAI))).toBeLessThan(160);
  });
});

describe("rankWorkersForJob — sort, never block", () => {
  const FAR: WorkerSignals = { ...STRONG, workerId: "w-far", location: MUMBAI };
  const JUNIOR: WorkerSignals = { ...STRONG, workerId: "w-junior", experienceYears: 1 };
  const OFF: WorkerSignals = { workerId: "w-off", roleId: "packer", lastActiveDaysAgo: 40 };
  const ALL = [OFF, FAR, STRONG, JUNIOR];

  it("returns EVERY worker (never filters) ordered best-first", () => {
    const ranked = rankWorkersForJob(JOB, ALL);
    expect(ranked).toHaveLength(ALL.length); // nobody dropped
    expect(new Set(ranked.map((r) => r.workerId)).size).toBe(ALL.length);
    // strictly non-increasing score down the list
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i]!.score).toBeLessThanOrEqual(ranked[i - 1]!.score);
    }
    expect(ranked[0]!.workerId).toBe("w-strong"); // best fit on top
    expect(ranked.at(-1)!.workerId).toBe("w-off"); // worst fit still present, at the bottom
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it("flags the hot top ~fraction, but the tag is gated on real candidates", () => {
    // All on-trade: the hot fraction applies → ~12% of 20 = 2 hot.
    const onTrade: WorkerSignals[] = Array.from({ length: 20 }, (_, i) => ({
      ...STRONG,
      workerId: `on-${i}`,
      lastActiveDaysAgo: i,
    }));
    expect(
      rankWorkersForJob(JOB, onTrade, { hotFraction: 0.12 }).filter((r) => r.hot).length,
    ).toBe(Math.round(20 * 0.12));

    // 1 on-trade + 19 off-trade: only the on-trade worker is hot — the off-trade
    // worker in the 2nd positional slot is gated out (§8.5).
    const mixed: WorkerSignals[] = [
      STRONG,
      ...Array.from({ length: 19 }, (_, i) => ({ workerId: `off-${i}`, roleId: "packer" })),
    ];
    const ranked = rankWorkersForJob(JOB, mixed, { hotFraction: 0.12 });
    const hot = ranked.filter((r) => r.hot);
    expect(hot.length).toBe(1);
    expect(ranked[0]!.workerId).toBe("w-strong");
    expect(hot.every((r) => r.components.find((c) => c.signal === "role")!.raw > 0)).toBe(true);
  });

  it("pushEligible gates push-notify, but low scorers still appear in the list", () => {
    const ranked = rankWorkersForJob(JOB, ALL, { pushFloor: 0.5 });
    const off = ranked.find((r) => r.workerId === "w-off")!;
    expect(off.pushEligible).toBe(false); // not pushed
    expect(ranked.some((r) => r.workerId === "w-off")).toBe(true); // but present
  });

  it("is deterministic and stable (ties broken by activity then id)", () => {
    const a = rankWorkersForJob(JOB, ALL).map((r) => r.workerId);
    const b = rankWorkersForJob(JOB, [...ALL].reverse()).map((r) => r.workerId);
    expect(a).toEqual(b);
  });

  it("handles an empty candidate set", () => {
    expect(rankWorkersForJob(JOB, [])).toEqual([]);
  });

  it("an all-off-trade feed yields ZERO hot workers (§8.5 — off-trade never hot)", () => {
    const offs: WorkerSignals[] = Array.from({ length: 8 }, (_, i) => ({
      workerId: `pk-${i}`,
      roleId: "packer",
      lastActiveDaysAgo: i,
    }));
    const ranked = rankWorkersForJob(JOB, offs);
    expect(ranked).toHaveLength(8); // sort-never-block: nobody dropped
    expect(ranked.every((r) => !r.hot)).toBe(true); // none "hot" — no real candidate to feature
  });
});

describe("degenerate / hardening inputs", () => {
  it("a zero/negative pay offer is 'not specified', not a hard fail (no Infinity)", () => {
    const r = scoreWorkerForJob({ ...JOB, payMin: 25000, payMax: 0 }, STRONG);
    const pay = r.components.find((c) => c.signal === "pay")!;
    expect(pay.raw).toBe(0.7);
    expect(pay.reason).not.toMatch(/Infinity/);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it("NaN/garbage inputs never produce a NaN or Infinity score", () => {
    const cases: WorkerSignals[] = [
      { workerId: "nan-salary", roleId: "vmc_operator", expectedSalary: NaN as unknown as number },
      { workerId: "nan-geo", roleId: "vmc_operator", location: { lat: NaN, lng: NaN } },
    ];
    for (const w of cases) {
      const s = scoreWorkerForJob({ ...JOB, payMax: 0, maxTravelKm: 0 }, w);
      expect(Number.isFinite(s.score)).toBe(true);
    }
  });

  it("ranking stays deterministic even with a NaN-producing worker (input-order independent)", () => {
    const poison: WorkerSignals = {
      workerId: "poison",
      roleId: "vmc_operator",
      expectedSalary: NaN as unknown as number,
    };
    const set: WorkerSignals[] = [poison, STRONG, { workerId: "w2", roleId: "packer" }];
    const a = rankWorkersForJob(JOB, set).map((r) => r.workerId);
    const b = rankWorkersForJob(JOB, [...set].reverse()).map((r) => r.workerId);
    expect(a).toEqual(b); // same set, any input order → same ranking
    expect(a).toHaveLength(3); // nobody dropped
  });
});

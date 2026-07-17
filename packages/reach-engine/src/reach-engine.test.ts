import { describe, it, expect } from "vitest";
import { scoreWorkerForJob, rankWorkersForJob, haversineKm, skillsOverlap, WEIGHTS } from "./index";
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
    expect(r.components).toHaveLength(7); // + skills since ADR-0033
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

describe("skills-overlap factor (ADR-0033 — the 2026-06-19 CEO ledger's Skills 15)", () => {
  const SKILLED_JOB: JobSpec = {
    ...JOB,
    skillIds: ["skill_milling", "skill_turning", "skill_deburring", "skill_cad_interpretation"],
  };
  const skillsComponent = (job: JobSpec, w: WorkerSignals) =>
    scoreWorkerForJob(job, w).components.find((c) => c.signal === "skills")!;

  it("pins the CEO weight ledger (edit only via a new ADR + this package's lock test)", () => {
    expect(WEIGHTS).toEqual({
      role: 0.35,
      distance: 0.2,
      skills: 0.15,
      experience: 0.15,
      pay: 0.1,
      availability: 0.05,
      activity: 0,
    });
  });

  it("skillsOverlap = |intersection| / |job required set|, bounded [0,1]", () => {
    expect(skillsOverlap(["skill_milling", "skill_turning"], SKILLED_JOB.skillIds)).toBe(0.5);
    expect(skillsOverlap(SKILLED_JOB.skillIds, SKILLED_JOB.skillIds)).toBe(1);
    expect(skillsOverlap(["skill_welding"], SKILLED_JOB.skillIds)).toBe(0);
    expect(skillsOverlap([], SKILLED_JOB.skillIds)).toBe(0);
    expect(skillsOverlap(undefined, SKILLED_JOB.skillIds)).toBe(0);
    expect(skillsOverlap(["skill_milling"], [])).toBe(0); // empty job set → caller redistributes
    expect(skillsOverlap(["skill_milling"], undefined)).toBe(0);
  });

  it("deduplicates + ignores blank/garbage entries on BOTH sides", () => {
    // job [a, a, b] is the set {a, b}; worker dupes/blanks don't inflate the overlap
    expect(
      skillsOverlap(
        ["skill_milling", "skill_milling", "  ", ""],
        ["skill_milling", "skill_milling", "skill_turning"],
      ),
    ).toBe(0.5);
  });

  it("monotonic: gaining a REQUIRED skill raises the score; an unrelated one changes nothing", () => {
    const none = scoreWorkerForJob(SKILLED_JOB, { ...STRONG, skillIds: [] }).score;
    const one = scoreWorkerForJob(SKILLED_JOB, { ...STRONG, skillIds: ["skill_milling"] }).score;
    const two = scoreWorkerForJob(SKILLED_JOB, {
      ...STRONG,
      skillIds: ["skill_milling", "skill_turning"],
    }).score;
    expect(one).toBeGreaterThan(none);
    expect(two).toBeGreaterThan(one);
    // A non-required skill neither helps nor hurts (order-only, never a penalty).
    const withUnrelated = scoreWorkerForJob(SKILLED_JOB, {
      ...STRONG,
      skillIds: ["skill_milling", "skill_welding"],
    }).score;
    expect(withUnrelated).toBeCloseTo(one, 12);
  });

  // ==========================================================================
  // GOLDEN REGRESSION — the REAL old-vs-new delta on a SKILL-LESS job.
  //
  // This exists because a "skill-less jobs are unaffected" claim was made and was
  // FALSE. Redistribution neutralizes the SKILLS factor only; the same CEO ledger
  // ALSO cut availability .10→.05 and activity .10→0, which hit EVERY job. Since the
  // demand side is unwired (no job carries skillIds today), EVERY live job takes the
  // redistribution path and is scored under a materially different effective vector:
  //   old: role .35   distance .20   exp .15   pay .10   avail .10   activity .10
  //   new: role .4118 distance .2353 exp .1765 pay .1176 avail .0588 activity 0
  // The golden below PINS the values so the delta is VISIBLE in review forever,
  // instead of being asserted away. The owner's 2026-07-17 ledger ruling authorizes
  // the change; this test refuses to let it happen silently.
  // ==========================================================================
  it("GOLDEN: pinned scores on a SKILL-LESS job — the deploy RE-RANKS (owner-ruled)", () => {
    // A fixed, deliberately varied fleet on the skill-less JOB fixture.
    const FLEET: WorkerSignals[] = [
      { workerId: "g-perfect", roleId: "vmc_operator", experienceYears: 5, expectedSalary: 28000, location: PUNE, availability: "immediate", lastActiveDaysAgo: 1 },
      { workerId: "g-active-midavail", roleId: "vmc_operator", experienceYears: 5, expectedSalary: 28000, location: PUNE, availability: "notice_period", lastActiveDaysAgo: 1 },
      { workerId: "g-avail-inactive", roleId: "vmc_operator", experienceYears: 5, expectedSalary: 28000, location: PUNE, availability: "immediate", lastActiveDaysAgo: 60 },
      { workerId: "g-thin", roleId: "vmc_operator" },
      { workerId: "g-offtrade", roleId: "packer", location: MUMBAI, availability: "not_looking", lastActiveDaysAgo: 90 },
    ];
    const scores = Object.fromEntries(
      FLEET.map((w) => [w.workerId, Number(scoreWorkerForJob(JOB, w).score.toFixed(6))]),
    );

    // PRE-ADR-0033 values are recorded in the comment; the pinned literals are the
    // POST-0033 truth, updated in the SAME diff that changed the ledger (per the
    // golden's own contract). Deltas below are MEASURED head-to-head (raws are
    // identical across regimes — no factor fn changed — so old = Σ(old weight × raw)):
    //   worker             OLD      → NEW        Δ
    //   g-perfect          1.000000 → 1.000000   0          (a perfect non-skills
    //                                                        match still scores EXACTLY 1.0)
    //   g-active-midavail  0.950000 → 0.970588  +0.020588
    //   g-avail-inactive   0.920000 → 1.000000  +0.080000   ← max |Δ| in this fleet
    //   g-thin             0.665000 → 0.717647  +0.052647
    //   g-offtrade         0.185000 → 0.188235  +0.003235
    // ORDER CHANGED: old  g-perfect > g-active-midavail > g-avail-inactive > g-thin > g-offtrade
    //                new  g-perfect > g-avail-inactive > g-active-midavail > g-thin > g-offtrade
    // Fleet-wide measurement across the whole engine (reviewer, 5000 pairs): 5000/5000
    // scores changed, max |Δ| 0.109538, 413/5000 (8.3%) pushEligible flips, 200/200
    // fleet orders changed. Authorized by the owner's 2026-07-17 ledger ruling.
    expect(scores).toEqual({
      "g-perfect": 1,
      "g-active-midavail": 0.970588,
      "g-avail-inactive": 1,
      "g-thin": 0.717647,
      "g-offtrade": 0.188235,
    });

    // THE INVERSION, pinned explicitly: pre-0033 the ACTIVE worker outranked the
    // AVAILABLE-but-inactive one (0.950 > 0.920). Dropping activity to 0 flips it.
    // This is the ledger's intent (activity is not a CEO-ledger signal), not a bug.
    expect(scores["g-avail-inactive"]!).toBeGreaterThan(scores["g-active-midavail"]!);

    // A perfect non-skills match still scores EXACTLY 1.0 — the ×(1/0.85) arithmetic
    // introduces no float drift (this sub-claim survived review; assert it exactly).
    expect(scoreWorkerForJob(JOB, FLEET[0]!).score).toBe(1);
  });

  it("a worker with NO confirmed skills scores 0 on the factor ONLY — never a block", () => {
    const c = skillsComponent(SKILLED_JOB, { ...STRONG, skillIds: undefined });
    expect(c.raw).toBe(0);
    expect(c.weight).toBe(WEIGHTS.skills);
    // Still present in the ranking (sort-never-block).
    const ranked = rankWorkersForJob(SKILLED_JOB, [
      { ...STRONG, workerId: "w-skilled", skillIds: [...SKILLED_JOB.skillIds!] },
      { ...STRONG, workerId: "w-unskilled", skillIds: [] },
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.workerId).toBe("w-skilled");
    expect(ranked.some((r) => r.workerId === "w-unskilled")).toBe(true);
  });

  it("a SKILL-LESS job redistributes the weight — THE SKILLS FACTOR cannot reorder it", () => {
    // Identical scores whatever the worker's skills are: the factor is order-neutral
    // where the job states no requirements (ADR-0033 zero-set semantics).
    const a = scoreWorkerForJob(JOB, { ...STRONG, skillIds: ["skill_milling"] });
    const b = scoreWorkerForJob(JOB, { ...STRONG, skillIds: [] });
    const c = scoreWorkerForJob(JOB, { ...STRONG, skillIds: undefined });
    expect(a.score).toBe(b.score);
    expect(b.score).toBe(c.score);
    // The skills component shows weight 0 (redistributed), and the OTHER effective
    // weights sum to 1.0 — no flat inflation, pushEligible semantics preserved.
    const skills = a.components.find((x) => x.signal === "skills")!;
    expect(skills.weight).toBe(0);
    const weightSum = a.components.reduce((s, x) => s + x.weight, 0);
    expect(weightSum).toBeCloseTo(1, 12);
    // A perfect non-skills match still scores 1.0 on a skill-less job (stability).
    expect(a.score).toBeCloseTo(1, 12);
  });

  it("score == Σ(effective weight × raw) in BOTH modes (explainability stays exact)", () => {
    for (const job of [JOB, SKILLED_JOB]) {
      const r = scoreWorkerForJob(job, { ...STRONG, skillIds: ["skill_milling"] });
      const sum = r.components.reduce((s, c) => s + c.weight * c.raw, 0);
      expect(r.score).toBeCloseTo(sum, 12);
    }
  });

  it("is deterministic with skills present — identical inputs, identical result", () => {
    const w = { ...STRONG, skillIds: ["skill_milling", "skill_turning"] };
    expect(scoreWorkerForJob(SKILLED_JOB, w)).toEqual(scoreWorkerForJob(SKILLED_JOB, w));
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

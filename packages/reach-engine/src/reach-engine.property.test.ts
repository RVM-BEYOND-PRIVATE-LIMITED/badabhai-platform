import { describe, it, expect } from "vitest";
import { scoreWorkerForJob, rankWorkersForJob } from "./index";
import type { JobSpec, RankOptions, WorkerJobScore, WorkerSignals } from "./index";

/**
 * Property / invariant tests for the Reach RANK core.
 *
 * Deterministic by construction: a seeded PRNG (mulberry32) drives the generators, so
 * every run explores the SAME thousands of cases — a failure is reproducible from the
 * fixed seed (no flakiness, no extra dependency). The generators deliberately mix valid
 * values with ADVERSARIAL ones (NaN / ±Infinity / negative / absurdly large / null /
 * missing / garbage geo) to assert the engine's invariants hold under hostile input.
 *
 * Invariants asserted:
 *  - score and every component.raw are finite and in [0,1] — always.
 *  - a corrupt numeric/geo signal is treated as UNKNOWN (neutral), never a penalty (§3).
 *  - rankWorkersForJob never drops anyone (sort-never-block), ranks 1..n, non-increasing.
 *  - ranking is input-order independent for unique ids (deterministic).
 *  - hot is bounded and gated on a real candidate; flags are booleans.
 *  - adversarial RankOptions never break any of the above.
 *  - a huge fleet terminates, preserves everyone, stays deterministic.
 */

// --- seeded PRNG (deterministic; no Math.random so CI is reproducible) ----------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

// Stringify a case with NaN/Infinity preserved (JSON would turn them into null).
const show = (ctx: unknown): string =>
  JSON.stringify(ctx, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v));
function fail(msg: string, ctx: unknown): never {
  throw new Error(`${msg} — case: ${show(ctx)}`);
}

const ADVERSARIAL = [NaN, Infinity, -Infinity, 0, -1, -50000, 1e12, Number.MAX_SAFE_INTEGER] as const;
const ROLES = ["vmc_operator", "packer", "welder", "cnc_operator", null, undefined] as const;
const AVAILS = ["immediate", "notice_period", "not_looking", "unknown", null, undefined] as const;
const CITIES = ["pune", "mumbai", null, undefined] as const;

/** A field value that is sometimes valid, sometimes garbage, sometimes absent. */
function noisyNum(rng: () => number, valid: () => number): number | null | undefined {
  const r = rng();
  if (r < 0.18) return pick(rng, ADVERSARIAL); // garbage
  if (r < 0.28) return null; // unknown
  if (r < 0.33) return undefined; // missing
  return valid();
}
const jobNum = (v: number | null | undefined): number | undefined => (v == null ? undefined : v);

function genGeo(rng: () => number): WorkerSignals["location"] {
  const r = rng();
  if (r < 0.1) return null;
  if (r < 0.15) return undefined;
  if (r < 0.27) return { lat: pick(rng, ADVERSARIAL), lng: pick(rng, ADVERSARIAL) }; // garbage geo
  return { lat: -90 + rng() * 180, lng: -180 + rng() * 360 };
}

function genWorker(rng: () => number, i: number): WorkerSignals {
  return {
    workerId: `w-${i}`,
    roleId: pick(rng, ROLES),
    secondaryRoleIds: rng() < 0.3 ? [pick(rng, ["vmc_operator", "welder"] as const)] : undefined,
    experienceYears: noisyNum(rng, () => Math.floor(rng() * 40)),
    expectedSalary: noisyNum(rng, () => Math.floor(rng() * 80000)),
    location: genGeo(rng),
    city: pick(rng, CITIES),
    travelRadiusKm: noisyNum(rng, () => Math.floor(rng() * 100)),
    availability: pick(rng, AVAILS),
    lastActiveDaysAgo: noisyNum(rng, () => Math.floor(rng() * 60)),
  };
}

function genJob(rng: () => number): JobSpec {
  const geo = genGeo(rng);
  return {
    jobId: "job",
    roleIds: rng() < 0.1 ? [] : [pick(rng, ["vmc_operator", "welder", "cnc_operator"] as const)],
    location: geo ?? undefined,
    city: pick(rng, CITIES) ?? undefined,
    maxTravelKm: jobNum(noisyNum(rng, () => Math.floor(rng() * 80))),
    minExperienceYears: jobNum(noisyNum(rng, () => Math.floor(rng() * 10))),
    maxExperienceYears: jobNum(noisyNum(rng, () => 10 + Math.floor(rng() * 20))),
    payMin: jobNum(noisyNum(rng, () => Math.floor(rng() * 30000))),
    payMax: jobNum(noisyNum(rng, () => 30000 + Math.floor(rng() * 30000))),
    neededBy: pick(rng, ["immediate", "soon", "flexible", undefined] as const),
  };
}

const roleRawOf = (r: WorkerJobScore): number =>
  r.components.find((c) => c.signal === "role")?.raw ?? -1;

function checkScore(r: WorkerJobScore, ctx: unknown): void {
  if (!(Number.isFinite(r.score) && r.score >= 0 && r.score <= 1)) fail(`bad score ${r.score}`, ctx);
  if (r.components.length !== 6) fail(`expected 6 components, got ${r.components.length}`, ctx);
  for (const c of r.components) {
    if (!(Number.isFinite(c.raw) && c.raw >= 0 && c.raw <= 1)) fail(`bad ${c.signal}.raw=${c.raw}`, ctx);
    if (!c.reason || c.reason.length === 0) fail(`empty reason for ${c.signal}`, ctx);
  }
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("scoreWorkerForJob — invariants under adversarial input", () => {
  it("score + every component.raw is finite and in [0,1] for ANY job × worker", () => {
    const rng = mulberry32(0xc0ffee);
    let cases = 0;
    for (let k = 0; k < 3000; k++) {
      const job = genJob(rng);
      const worker = genWorker(rng, k);
      let r: WorkerJobScore;
      try {
        r = scoreWorkerForJob(job, worker);
      } catch (e) {
        fail(`threw: ${String(e)}`, { job, worker });
      }
      checkScore(r, { job, worker });
      cases++;
    }
    expect(cases).toBe(3000);
  });

  it("a corrupt numeric/geo signal is treated as UNKNOWN, never a penalty (§3)", () => {
    const job: JobSpec = {
      jobId: "j",
      roleIds: ["vmc_operator"],
      location: { lat: 18.52, lng: 73.86 },
      payMin: 20000,
      payMax: 30000,
      minExperienceYears: 3,
      maxExperienceYears: 10,
      neededBy: "soon",
    };
    const base: WorkerSignals = { workerId: "w", roleId: "vmc_operator" };
    const garbage = [NaN, Infinity, -Infinity];
    const eq = (a: WorkerSignals, b: WorkerSignals) =>
      expect(scoreWorkerForJob(job, a).score).toBeCloseTo(scoreWorkerForJob(job, b).score, 10);

    for (const g of garbage) {
      eq({ ...base, expectedSalary: g }, { ...base, expectedSalary: null });
      eq({ ...base, experienceYears: g }, { ...base, experienceYears: null });
      eq({ ...base, lastActiveDaysAgo: g }, { ...base, lastActiveDaysAgo: null });
      eq({ ...base, location: { lat: g, lng: g } }, { ...base, location: null });
      eq({ ...base, travelRadiusKm: g }, { ...base, travelRadiusKm: null });
    }
    // And a corrupt signal must never score BELOW a confirmed-bad one (e.g. salary way
    // over the offer): unknown gets benefit of the doubt.
    const corrupt = scoreWorkerForJob(job, { ...base, expectedSalary: NaN }).score;
    const wayOver = scoreWorkerForJob(job, { ...base, expectedSalary: 10_000_000 }).score;
    expect(corrupt).toBeGreaterThanOrEqual(wayOver);
  });
});

describe("rankWorkersForJob — invariants over random fleets", () => {
  it("never drops anyone; ranks are 1..n; scores non-increasing; flags valid; hot gated", () => {
    const rng = mulberry32(0x1234abcd);
    for (let trial = 0; trial < 300; trial++) {
      const job = genJob(rng);
      const n = Math.floor(rng() * 60);
      const workers = Array.from({ length: n }, (_, i) => genWorker(rng, i));
      const ranked = rankWorkersForJob(job, workers);

      if (ranked.length !== n) fail(`dropped someone: ${ranked.length} != ${n}`, { n });
      if (new Set(ranked.map((r) => r.workerId)).size !== n) fail("duplicate/missing id", { n });
      expect(ranked.map((r) => r.rank)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      for (let i = 1; i < n; i++) {
        if (ranked[i]!.score > ranked[i - 1]!.score + 1e-9) fail(`out of order at ${i}`, { trial, i });
      }
      for (const r of ranked) {
        checkScore(r, r);
        if (typeof r.hot !== "boolean" || typeof r.pushEligible !== "boolean") fail("flag not boolean", r);
        if (r.hot && roleRawOf(r) <= 0) fail("off-trade worker flagged hot (§8.5)", r);
      }
    }
  });

  it("is input-order independent for unique ids (deterministic)", () => {
    const rng = mulberry32(0xabcde123);
    for (let trial = 0; trial < 150; trial++) {
      const job = genJob(rng);
      const n = 1 + Math.floor(rng() * 40);
      const workers = Array.from({ length: n }, (_, i) => genWorker(rng, i));
      const a = rankWorkersForJob(job, workers).map((r) => r.workerId);
      const b = rankWorkersForJob(job, shuffle(workers, rng)).map((r) => r.workerId);
      if (show(a) !== show(b)) fail(`order depends on input order`, { a, b });
    }
  });

  it("adversarial RankOptions never break sort-never-block; hot ∈ [0,n]; flags boolean", () => {
    const rng = mulberry32(0x55aa55);
    const job = genJob(rng);
    const workers = Array.from({ length: 20 }, (_, i) => genWorker(rng, i));
    const badOpts: RankOptions[] = [
      { hotFraction: NaN },
      { hotFraction: Infinity },
      { hotFraction: -5 },
      { hotFraction: 99 },
      { pushFloor: NaN },
      { pushFloor: -1 },
      { pushFloor: 50 },
      { defaultMaxTravelKm: NaN },
      { defaultMaxTravelKm: -10 },
      { defaultMaxTravelKm: 0 },
      { hotFraction: NaN, pushFloor: NaN, defaultMaxTravelKm: NaN },
    ];
    for (const opts of badOpts) {
      const ranked = rankWorkersForJob(job, workers, opts);
      expect(ranked).toHaveLength(20);
      const hot = ranked.filter((r) => r.hot).length;
      expect(hot).toBeGreaterThanOrEqual(0);
      expect(hot).toBeLessThanOrEqual(20);
      for (const r of ranked) {
        if (typeof r.hot !== "boolean" || typeof r.pushEligible !== "boolean") fail("flag not boolean", { opts, r });
        checkScore(r, { opts, r });
      }
    }
  });

  it("a huge fleet (5000) terminates, preserves everyone, and is deterministic", () => {
    const rng = mulberry32(0x99bb);
    const job = genJob(rng);
    const workers = Array.from({ length: 5000 }, (_, i) => genWorker(rng, i));
    const a = rankWorkersForJob(job, workers);
    expect(a).toHaveLength(5000);
    expect(new Set(a.map((r) => r.workerId)).size).toBe(5000);
    expect(a.map((r) => r.rank)).toEqual(Array.from({ length: 5000 }, (_, i) => i + 1));
    const b = rankWorkersForJob(job, [...workers].reverse());
    expect(b.map((r) => r.workerId)).toEqual(a.map((r) => r.workerId));
  });
});

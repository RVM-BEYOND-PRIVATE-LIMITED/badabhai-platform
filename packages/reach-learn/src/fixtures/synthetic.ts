/**
 * Deterministic, PII-FREE synthetic event stream for the LEARN eval harness.
 *
 * WHY synthetic: the real `events` stream currently has ZERO `feed.shown`/
 * `application.*` rows (the feed surface has not run at volume) — verified 2026-06-17.
 * This fixture generates a reproducible stream with a KNOWN latent preference that
 * differs from the ADR-0006 baseline weights, so the calibrator can demonstrably
 * recover signal (NDCG ↑) while the guardrail holds. It contains NO PII — only role
 * ids, bands, coarse city centroids, and ids. It is a METHODOLOGY harness, not a
 * claim about production data.
 */
import type { JobSpec, WorkerSignals } from "@badabhai/reach-engine";
import { buildFeatureVector } from "../features";
import { scoreByWeights } from "../metrics";
import type { LearnEvent, SignalSnapshot, WeightVector } from "../types";

/**
 * The latent "truth" — within ±0.10 of baseline so a bounded calibrator can find it.
 * NOTE: the planted signal is on JOB-VARYING signals (pay ↑, experience ↓). `activity`
 * is a worker-level signal (constant across a worker's feed) so it carries no intra-feed
 * ranking signal — planting on it would be unrecoverable by construction.
 */
export const TRUE_WEIGHTS: WeightVector = {
  role: 0.35,
  distance: 0.2,
  experience: 0.05,
  pay: 0.2,
  availability: 0.1,
  activity: 0.1,
};

const ROLES = ["role_a", "role_b", "role_c", "role_d", "role_e"];
const CITIES: Array<{ city: string; lat: number; lng: number }> = [
  { city: "pune", lat: 18.52, lng: 73.85 },
  { city: "nashik", lat: 19.99, lng: 73.79 },
  { city: "aurangabad", lat: 19.88, lng: 75.34 },
  { city: "mumbai", lat: 19.07, lng: 72.88 },
];

/** mulberry32 — tiny deterministic PRNG (seeded; no global randomness). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const id = (prefix: string, n: number): string => `${prefix}-${String(n).padStart(4, "0")}`;

export interface SyntheticOptions {
  seed?: number;
  workers?: number;
  jobs?: number;
  /** Jobs shown per worker (the feed size). */
  feedSize?: number;
  /** Fraction of workers made deliberately cold/sparse (tests cohort widening). */
  coldFraction?: number;
}

export interface SyntheticData {
  events: LearnEvent[];
  snapshot: SignalSnapshot;
}

/** Build a reproducible PII-free dataset. Same seed+opts → byte-identical output. */
export function buildSyntheticData(opts: SyntheticOptions = {}): SyntheticData {
  const seed = opts.seed ?? 42;
  const nWorkers = opts.workers ?? 90;
  const nJobs = opts.jobs ?? 16;
  const feedSize = opts.feedSize ?? 10;
  const coldFraction = opts.coldFraction ?? 0.25;
  const r = rng(seed);

  const jobs: Record<string, JobSpec> = {};
  for (let j = 0; j < nJobs; j++) {
    const c = pick(r, CITIES);
    jobs[id("job", j)] = {
      jobId: id("job", j),
      roleIds: [pick(r, ROLES)],
      location: { lat: c.lat, lng: c.lng },
      city: c.city,
      maxTravelKm: 50,
      minExperienceYears: Math.floor(r() * 3),
      maxExperienceYears: 5 + Math.floor(r() * 6),
      payMin: 15000 + Math.floor(r() * 5) * 1000,
      payMax: 25000 + Math.floor(r() * 10) * 1000,
      neededBy: pick(r, ["immediate", "soon", "flexible"] as const),
    };
  }

  const workers: Record<string, WorkerSignals> = {};
  for (let w = 0; w < nWorkers; w++) {
    const cold = r() < coldFraction;
    const c = pick(r, CITIES);
    workers[id("wkr", w)] = cold
      ? {
          // sparse/cold profile — little for the engine to rank on (tests widening).
          workerId: id("wkr", w),
          roleId: r() < 0.5 ? null : pick(r, ROLES),
          city: c.city,
          lastActiveDaysAgo: 40 + Math.floor(r() * 30),
        }
      : {
          workerId: id("wkr", w),
          roleId: pick(r, ROLES),
          secondaryRoleIds: r() < 0.4 ? [pick(r, ROLES)] : [],
          experienceYears: Math.floor(r() * 10),
          expectedSalary: 18000 + Math.floor(r() * 12) * 1000,
          location: { lat: c.lat, lng: c.lng },
          city: c.city,
          travelRadiusKm: 30 + Math.floor(r() * 40),
          availability: pick(r, ["immediate", "notice_period", "not_looking", "unknown"] as const),
          lastActiveDaysAgo: Math.floor(r() * 20),
        };
  }

  const snapshot: SignalSnapshot = { jobs, workers };
  const workerIds = Object.keys(workers);
  const jobIds = Object.keys(jobs);

  const events: LearnEvent[] = [];
  let clock = Date.UTC(2026, 0, 1);
  const tick = (): string => {
    clock += 60_000; // 1 min apart → a clean temporal order for the split
    return new Date(clock).toISOString();
  };

  for (const workerId of workerIds) {
    const worker = workers[workerId]!;
    // The worker's feed: jobs ordered by a noisy true-relevance, top `feedSize`.
    const scored = jobIds.map((jobId) => {
      const trueScore = scoreByWeights(buildFeatureVector(jobs[jobId]!, worker), TRUE_WEIGHTS);
      return { jobId, trueScore, noisy: trueScore + (r() - 0.5) * 0.2 };
    });
    scored.sort((a, b) => b.noisy - a.noisy);
    const feed = scored.slice(0, Math.min(feedSize, scored.length));
    const meanTrue = feed.reduce((s, f) => s + f.trueScore, 0) / Math.max(1, feed.length);

    let appliedAny = false;
    feed.forEach((f, i) => {
      const rank = i + 1;
      const shownAt = tick();
      events.push({
        event_name: "feed.shown",
        payload: { worker_id: workerId, job_id: f.jobId, rank, score: f.trueScore, hot: rank <= 2 },
        created_at: shownAt,
      });
      // Examination falls with rank (position bias → IPW matters).
      const examined = r() < 1 / Math.log2(rank + 1) + 0.25;
      if (!examined) return;
      const applies = f.trueScore >= meanTrue && r() < 0.85;
      if (applies) {
        appliedAny = true;
        events.push({
          event_name: "application.submitted",
          payload: { worker_id: workerId, job_id: f.jobId, rank, source_surface: "feed" },
          created_at: tick(),
        });
      } else {
        events.push({
          event_name: "application.skipped",
          payload: {
            worker_id: workerId,
            job_id: f.jobId,
            reason: pick(r, ["not_interested", "too_far", "low_pay", "wrong_trade", "other"] as const),
          },
          created_at: tick(),
        });
      }
    });
    // Guarantee >=1 positive per query so NDCG is defined for this worker.
    if (!appliedAny && feed[0]) {
      events.push({
        event_name: "application.submitted",
        payload: { worker_id: workerId, job_id: feed[0].jobId, rank: 1, source_surface: "feed" },
        created_at: tick(),
      });
    }
  }

  return { events, snapshot };
}

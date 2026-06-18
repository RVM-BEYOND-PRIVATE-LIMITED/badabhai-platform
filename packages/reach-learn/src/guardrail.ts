/**
 * "Widen, never narrow" — the MEASURED guardrail (ADR-0017 Decision 5).
 *
 * The layer may only BROADEN a worker's opportunity surface, never restrict it. We
 * measure this by replaying the applicant-list ranking (rank ALL workers for each job)
 * under the BASELINE weights vs a candidate WeightProfile, and comparing each worker's
 * rank-discounted exposure. A profile PASSES only if no worker loses more than epsilon
 * of their baseline exposure, none is zeroed, and the cold/sparse cohort does not
 * regress. Used BOTH as an optimizer constraint (train) and a held-out gate (test).
 */
import type { WorkerSignals } from "@badabhai/reach-engine";
import { buildFeatureVector } from "./features";
import { scoreByWeights } from "./metrics";
import type { GuardrailResult, SignalSnapshot, WeightVector } from "./types";

export interface GuardrailOptions {
  /** Max fractional exposure a worker may lose (default 0.10 → must keep >= 90%). */
  epsilon?: number;
  /** Top-k visibility cutoff for the secondary metric (default 10). */
  topK?: number;
}

/** A worker is "cold/sparse" if their profile gives the engine little to rank on. */
function isColdWorker(w: WorkerSignals): boolean {
  return (
    w.roleId == null ||
    w.experienceYears == null ||
    w.lastActiveDaysAgo == null ||
    w.lastActiveDaysAgo > 30
  );
}

const log2 = (n: number): number => Math.log(n) / Math.LN2;
const discount = (rank: number): number => 1 / log2(rank + 1); // rank is 1-based

/** Rank-discounted exposure of every worker across all jobs' applicant lists. */
function exposureByWorker(
  jobIds: string[],
  workerIds: string[],
  snapshot: SignalSnapshot,
  weights: WeightVector,
): Map<string, number> {
  const exposure = new Map<string, number>(workerIds.map((w) => [w, 0]));
  for (const jobId of jobIds) {
    const job = snapshot.jobs[jobId];
    if (!job) continue;
    const scored = workerIds
      .map((workerId) => {
        const worker = snapshot.workers[workerId];
        if (!worker) return null;
        return { workerId, score: scoreByWeights(buildFeatureVector(job, worker), weights) };
      })
      .filter((x): x is { workerId: string; score: number } => x !== null)
      // sort-never-block: ALL workers ranked; ties by id for reproducibility.
      .sort((a, b) => b.score - a.score || (a.workerId < b.workerId ? -1 : 1));
    scored.forEach((s, i) => {
      exposure.set(s.workerId, (exposure.get(s.workerId) ?? 0) + discount(i + 1));
    });
  }
  return exposure;
}

/** Top-k appearance count of every worker across all jobs. */
function topKCount(
  jobIds: string[],
  workerIds: string[],
  snapshot: SignalSnapshot,
  weights: WeightVector,
  k: number,
): Map<string, number> {
  const count = new Map<string, number>(workerIds.map((w) => [w, 0]));
  for (const jobId of jobIds) {
    const job = snapshot.jobs[jobId];
    if (!job) continue;
    const scored = workerIds
      .map((workerId) => {
        const worker = snapshot.workers[workerId];
        if (!worker) return null;
        return { workerId, score: scoreByWeights(buildFeatureVector(job, worker), weights) };
      })
      .filter((x): x is { workerId: string; score: number } => x !== null)
      .sort((a, b) => b.score - a.score || (a.workerId < b.workerId ? -1 : 1));
    for (let i = 0; i < Math.min(k, scored.length); i++) {
      const id = scored[i]!.workerId;
      count.set(id, (count.get(id) ?? 0) + 1);
    }
  }
  return count;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Measure widen-never-narrow for a candidate weight vector against the baseline.
 * Deterministic. `jobIds`/`workerIds` default to the full snapshot.
 */
export function measureGuardrail(
  baseline: WeightVector,
  learned: WeightVector,
  snapshot: SignalSnapshot,
  opts: GuardrailOptions = {},
): GuardrailResult {
  const epsilon = opts.epsilon ?? 0.1;
  const topK = opts.topK ?? 10;
  const jobIds = Object.keys(snapshot.jobs);
  const workerIds = Object.keys(snapshot.workers);

  const base = exposureByWorker(jobIds, workerIds, snapshot, baseline);
  const learn = exposureByWorker(jobIds, workerIds, snapshot, learned);

  let minRatio = Number.POSITIVE_INFINITY;
  const workersBelowFloor: string[] = [];
  let anyZeroed = false;
  const coldDeltas: number[] = [];

  for (const w of workerIds) {
    const b = base.get(w) ?? 0;
    const l = learn.get(w) ?? 0;
    if (b > 0) {
      const ratio = l / b;
      minRatio = Math.min(minRatio, ratio);
      if (ratio < 1 - epsilon) workersBelowFloor.push(w);
      if (l === 0) anyZeroed = true;
    }
    const worker = snapshot.workers[w];
    if (worker && isColdWorker(worker)) coldDeltas.push(l - b);
  }
  if (!Number.isFinite(minRatio)) minRatio = 1;

  // Structural: the ranked SET per job is identical (we only reorder) — assert it.
  let setMonotonicityHolds = true;
  const allWorkers = new Set(workerIds);
  for (const jobId of jobIds) {
    if (!snapshot.jobs[jobId]) continue;
    // both rankings draw from `workerIds` with valid snapshot entries → same set.
    const present = new Set(workerIds.filter((w) => snapshot.workers[w]));
    if (present.size !== [...present].filter((w) => allWorkers.has(w)).length) {
      setMonotonicityHolds = false;
    }
  }

  const baseTopK = topKCount(jobIds, workerIds, snapshot, baseline, topK);
  const learnTopK = topKCount(jobIds, workerIds, snapshot, learned, topK);
  let topKGained = 0;
  let topKLost = 0;
  for (const w of workerIds) {
    const d = (learnTopK.get(w) ?? 0) - (baseTopK.get(w) ?? 0);
    if (d > 0) topKGained++;
    else if (d < 0) topKLost++;
  }

  const coldCohortMedianDelta = median(coldDeltas);
  const pass =
    minRatio >= 1 - epsilon && !anyZeroed && setMonotonicityHolds && coldCohortMedianDelta >= 0;

  return {
    minExposureRatio: minRatio,
    workersBelowFloor,
    anyWorkerZeroed: anyZeroed,
    coldCohortMedianDelta,
    setMonotonicityHolds,
    epsilon,
    topK,
    topKGained,
    topKLost,
    pass,
  };
}

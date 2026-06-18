/**
 * SHADOW harness (ADR-0017 Decision 6) — compute + compare, SERVE NOTHING.
 *
 * Given a window of jobs/workers, rank each job's applicant list under the LIVE
 * baseline weights (what is actually served) and under a candidate WeightProfile (the
 * shadow), and return a PII-free comparison: rank deltas + the guardrail on the window.
 * This function NEVER mutates live ranking and returns no served order — it only
 * produces a report. Promotion to live is a SEPARATE human-gated decision.
 */
import { BASELINE_WEIGHTS } from "./model";
import { buildFeatureVector } from "./features";
import { measureGuardrail, type GuardrailOptions } from "./guardrail";
import { scoreByWeights } from "./metrics";
import type { GuardrailResult, SignalSnapshot, WeightProfile } from "./types";

/** A PII-free per-job rank comparison (ids + positions only). */
export interface ShadowJobComparison {
  jobId: string;
  /** Mean absolute rank change baseline→shadow across this job's workers. */
  meanAbsRankDelta: number;
  /** Largest single worker rank improvement (negative = moved up). */
  maxRankImprovement: number;
}

/** The PII-free shadow report. Nothing here is served. */
export interface ShadowReport {
  profileVersion: string;
  profileSignature: string;
  jobs: ShadowJobComparison[];
  /** Mean of per-job meanAbsRankDelta. */
  meanAbsRankDelta: number;
  guardrail: GuardrailResult;
  /** ALWAYS false in this harness — shadow never serves. */
  servedLive: false;
}

/** The PII-free event shape that a live shadow run WOULD log (ids/positions/metrics). */
export interface ShadowRankedEvent {
  event_name: "reach.shadow_ranked";
  payload: {
    job_id: string;
    profile_version: string;
    mean_abs_rank_delta: number;
    guardrail_pass: boolean;
    served: false;
  };
}

function rankWorkers(
  jobId: string,
  workerIds: string[],
  snapshot: SignalSnapshot,
  weights: { role: number; distance: number; experience: number; pay: number; availability: number; activity: number },
): string[] {
  const job = snapshot.jobs[jobId]!;
  return workerIds
    .map((workerId) => {
      const worker = snapshot.workers[workerId];
      if (!worker) return null;
      return { workerId, score: scoreByWeights(buildFeatureVector(job, worker), weights) };
    })
    .filter((x): x is { workerId: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || (a.workerId < b.workerId ? -1 : 1))
    .map((s) => s.workerId);
}

/** Compute the shadow comparison for a window. Pure; serves nothing. */
export function computeShadow(
  profile: WeightProfile,
  snapshot: SignalSnapshot,
  opts: GuardrailOptions = {},
): ShadowReport {
  const jobIds = Object.keys(snapshot.jobs);
  const workerIds = Object.keys(snapshot.workers);

  const jobs: ShadowJobComparison[] = [];
  for (const jobId of jobIds) {
    if (!snapshot.jobs[jobId]) continue;
    const baseOrder = rankWorkers(jobId, workerIds, snapshot, BASELINE_WEIGHTS);
    const shadowOrder = rankWorkers(jobId, workerIds, snapshot, profile.weights);
    const basePos = new Map(baseOrder.map((w, i) => [w, i + 1]));
    let absSum = 0;
    let maxImprovement = 0;
    shadowOrder.forEach((w, i) => {
      const delta = i + 1 - (basePos.get(w) ?? i + 1); // positive = moved down
      absSum += Math.abs(delta);
      if (delta < maxImprovement) maxImprovement = delta;
    });
    jobs.push({
      jobId,
      meanAbsRankDelta: shadowOrder.length ? absSum / shadowOrder.length : 0,
      maxRankImprovement: maxImprovement,
    });
  }

  const guardrail = measureGuardrail(BASELINE_WEIGHTS, profile.weights, snapshot, opts);
  const meanAbsRankDelta = jobs.length
    ? jobs.reduce((s, j) => s + j.meanAbsRankDelta, 0) / jobs.length
    : 0;

  return {
    profileVersion: profile.version,
    profileSignature: profile.signature,
    jobs,
    meanAbsRankDelta,
    guardrail,
    servedLive: false,
  };
}

/** Build the PII-free shadow events a live run would emit (NOT emitted here). */
export function buildShadowEvents(report: ShadowReport): ShadowRankedEvent[] {
  return report.jobs.map((j) => ({
    event_name: "reach.shadow_ranked",
    payload: {
      job_id: j.jobId,
      profile_version: report.profileVersion,
      mean_abs_rank_delta: j.meanAbsRankDelta,
      guardrail_pass: report.guardrail.pass,
      served: false,
    },
  }));
}

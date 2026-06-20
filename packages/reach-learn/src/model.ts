/**
 * Baseline LEARN model (ADR-0017 Decision 1) — BOUNDED coordinate-ascent calibration
 * of the six RANK weights, optimizing held-out NDCG@k on the TRAIN split.
 *
 * The model ASSISTS; it does not decide. Its only output is a {@link WeightProfile} —
 * the same six dials the engine already exposes, re-tuned within hard clamps. It can
 * NEVER zero a signal, dethrone role as the dominant signal, or move a weight outside
 * ±delta of its ADR-0006 value. "Widen, never narrow" is enforced AS AN OPTIMIZER
 * CONSTRAINT here (a candidate that narrows any worker's exposure is rejected) and
 * re-checked on held-out data in eval.ts. Deterministic: no randomness, fixed grid.
 */
import { WEIGHTS } from "@badabhai/reach-engine";
import { stableHash } from "./hash";
import { measureGuardrail } from "./guardrail";
import { computeMetrics, type MetricOptions } from "./metrics";
import { SIGNALS, type SignalSnapshot, type TrainingRow, type WeightProfile, type WeightVector } from "./types";

export interface CalibrationOptions extends MetricOptions {
  /** Max absolute move of any weight from its ADR-0006 baseline (default 0.10). */
  delta?: number;
  /** Lower clamp so NO signal can be switched off (default 0.02). */
  floor?: number;
  /** Coordinate-ascent passes over the six signals (default 3). */
  passes?: number;
  /** Grid step within a signal's bounds (default 0.025). */
  step?: number;
  /** Guardrail epsilon used as the optimizer constraint (default 0.10). */
  guardrailEpsilon?: number;
  /**
   * Enforce widen-never-narrow AS AN OPTIMIZER CONSTRAINT (default true). Set false
   * ONLY to demonstrate what the learner would do unconstrained — never for a profile
   * that could be promoted. With it on, a candidate that narrows any worker is rejected
   * even if it improves NDCG (the guardrail binds the model).
   */
  enforceGuardrail?: boolean;
  /** Min NDCG improvement to accept a candidate (default 1e-6). */
  minImprovement?: number;
  /**
   * Fraction of `train` (its NEWEST slice, by time) held out as a VALIDATION set the
   * grid selects on — improves generalization to the future test split vs fitting the
   * whole train. Default 0.25. Falls back to full train if validation is too sparse.
   */
  valFraction?: number;
  version?: string;
  datasetManifestHash?: string;
}

export const BASELINE_WEIGHTS: WeightVector = { ...WEIGHTS };

interface Bounds {
  lo: number;
  hi: number;
}

function boundsFor(signal: keyof WeightVector, delta: number, floor: number): Bounds {
  const base = BASELINE_WEIGHTS[signal];
  return { lo: Math.max(floor, base - delta), hi: Math.min(0.9, base + delta) };
}

/** Set w[signal]=value, redistribute the rest proportionally to baseline so Σ=1. */
function withWeight(
  current: WeightVector,
  signal: keyof WeightVector,
  value: number,
): WeightVector | null {
  const others = SIGNALS.filter((s) => s !== signal);
  const baseOthersSum = others.reduce((s, o) => s + BASELINE_WEIGHTS[o], 0);
  if (baseOthersSum <= 0) return null;
  const remaining = 1 - value;
  if (remaining <= 0) return null;
  const next = { ...current, [signal]: value } as WeightVector;
  for (const o of others) next[o] = (BASELINE_WEIGHTS[o] / baseOthersSum) * remaining;
  return next;
}

/** role must stay the dominant signal (the §3 "biggest factor" cannot be learned away). */
function roleDominant(w: WeightVector): boolean {
  return SIGNALS.every((s) => s === "role" || w.role >= w[s]);
}

function withinBounds(w: WeightVector, delta: number, floor: number): boolean {
  return SIGNALS.every((s) => {
    const { lo, hi } = boundsFor(s, delta, floor);
    return w[s] >= lo - 1e-9 && w[s] <= hi + 1e-9;
  });
}

/**
 * Calibrate a bounded WeightProfile from the train split. `snapshot` is needed so the
 * widen-never-narrow constraint can be enforced during the search (a narrowing
 * candidate is rejected even if it improves NDCG).
 */
export function calibrateWeights(
  train: TrainingRow[],
  snapshot: SignalSnapshot,
  opts: CalibrationOptions = {},
): WeightProfile {
  const delta = opts.delta ?? 0.1;
  const floor = opts.floor ?? 0.02;
  const passes = opts.passes ?? 3;
  const step = opts.step ?? 0.025;
  const eps = opts.guardrailEpsilon ?? 0.1;
  const minImp = opts.minImprovement ?? 1e-6;
  const valFraction = opts.valFraction ?? 0.25;
  const metricOpts: MetricOptions = { k: opts.k, ipw: opts.ipw, propensityFloor: opts.propensityFloor };

  // Select on a VALIDATION slice (newest part of train) to generalize forward, not
  // overfit the whole train. Fall back to full train when validation is too sparse.
  const sorted = [...train].sort((a, b) => (a.shownAt < b.shownAt ? -1 : a.shownAt > b.shownAt ? 1 : 0));
  const cut = Math.floor(sorted.length * (1 - valFraction));
  const val = sorted.slice(cut);
  const valQueriesWithPositive = new Set(val.filter((r) => r.label === 1).map((r) => r.groupKey)).size;
  const selectionSet = valQueriesWithPositive >= 3 ? val : train;

  let best: WeightVector = { ...BASELINE_WEIGHTS };
  let bestNdcg = computeMetrics(selectionSet, best, metricOpts).ndcg;

  for (let pass = 0; pass < passes; pass++) {
    let improvedThisPass = false;
    for (const signal of SIGNALS) {
      const { lo, hi } = boundsFor(signal, delta, floor);
      // Deterministic candidate grid within bounds (inclusive of hi).
      for (let v = lo; v <= hi + 1e-9; v += step) {
        const cand = withWeight(best, signal, round4(v));
        if (!cand) continue;
        if (!withinBounds(cand, delta, floor) || !roleDominant(cand)) continue;
        const ndcg = computeMetrics(selectionSet, cand, metricOpts).ndcg;
        if (ndcg <= bestNdcg + minImp) continue;
        // Only pay for the guardrail replay when NDCG actually improves (prune cost).
        if (
          (opts.enforceGuardrail ?? true) &&
          !measureGuardrail(BASELINE_WEIGHTS, cand, snapshot, { epsilon: eps, topK: opts.k ?? 10 }).pass
        ) {
          continue;
        }
        best = normalize(cand);
        bestNdcg = ndcg;
        improvedThisPass = true;
      }
    }
    if (!improvedThisPass) break;
  }

  const weights = normalize(best);
  const datasetManifestHash = opts.datasetManifestHash ?? "";
  return {
    version: opts.version ?? "wp-1",
    weights,
    datasetManifestHash,
    signature: stableHash({ weights, datasetManifestHash }),
    createdAt: new Date(0).toISOString(), // deterministic; the caller may overwrite
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Renormalize to Σ=1 (interpretability); ranking itself is scale-invariant. */
export function normalize(w: WeightVector): WeightVector {
  const sum = SIGNALS.reduce((s, k) => s + w[k], 0);
  if (sum <= 0) return { ...BASELINE_WEIGHTS };
  const out = {} as WeightVector;
  for (const k of SIGNALS) out[k] = round4(w[k] / sum);
  return out;
}

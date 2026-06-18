/**
 * Held-out offline evaluation (ADR-0017 Decision 3). Reports ranking quality
 * (NDCG@k / MAP / MRR, baseline vs learned, IPW-corrected) AND the measured
 * widen-never-narrow guardrail. PASS only if quality did not regress AND the guardrail
 * holds — this is the gate a profile must clear before SHADOW (Decision 6).
 */
import { BASELINE_WEIGHTS } from "./model";
import { measureGuardrail, type GuardrailOptions } from "./guardrail";
import { computeMetrics, type MetricOptions } from "./metrics";
import type { EvalResult, MetricPair, SignalSnapshot, TrainingRow, WeightProfile } from "./types";

export interface EvalOptions extends MetricOptions, GuardrailOptions {
  /** Allowed NDCG regression tolerance (default 0 → learned must be >= baseline). */
  ndcgTolerance?: number;
}

const pair = (baseline: number, learned: number): MetricPair => ({
  baseline,
  learned,
  delta: learned - baseline,
});

/** Evaluate a calibrated profile on the held-out test split + the snapshot. */
export function evaluate(
  test: TrainingRow[],
  profile: WeightProfile,
  snapshot: SignalSnapshot,
  opts: EvalOptions = {},
): EvalResult {
  const k = opts.k ?? 10;
  const ipw = opts.ipw ?? true;
  const metricOpts: MetricOptions = { k, ipw, propensityFloor: opts.propensityFloor };

  const base = computeMetrics(test, BASELINE_WEIGHTS, metricOpts);
  const learn = computeMetrics(test, profile.weights, metricOpts);
  const guardrail = measureGuardrail(BASELINE_WEIGHTS, profile.weights, snapshot, {
    epsilon: opts.epsilon,
    topK: opts.topK ?? k,
  });

  const ndcg = pair(base.ndcg, learn.ndcg);
  const tol = opts.ndcgTolerance ?? 0;
  const qualityOk = ndcg.delta >= -tol;

  return {
    ndcg,
    map: pair(base.map, learn.map),
    mrr: pair(base.mrr, learn.mrr),
    k,
    ipwCorrected: ipw,
    guardrail,
    queryCount: learn.scoredQueries,
    pass: qualityOk && guardrail.pass,
  };
}

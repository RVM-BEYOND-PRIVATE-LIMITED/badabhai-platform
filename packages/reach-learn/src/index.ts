/**
 * @badabhai/reach-learn — the LEARN layer (ADR-0017). OFFLINE-FIRST classical
 * learning-to-rank over the PII-free `events` stream. It calibrates the deterministic
 * RANK dials (ADR-0006) into a bounded, signed {@link WeightProfile}; the model
 * ASSISTS, the engine + caps DECIDE (invariant #4). No LLM. No live influence — the
 * engine code is untouched; this package only computes (dataset → model → eval →
 * shadow). Promotion to live ranking is a SEPARATE human-gated decision.
 */
export * from "./types";
export { assertEventPiiFree, assertFeatureVectorClean, buildFeatureVector, FEATURE_ALLOWLIST } from "./features";
export { assembleDataset, type DatasetOptions } from "./dataset";
export { computeMetrics, scoreByWeights, groupByQuery, type MetricOptions, type MetricSet } from "./metrics";
export { measureGuardrail, type GuardrailOptions } from "./guardrail";
export { calibrateWeights, normalize, BASELINE_WEIGHTS, type CalibrationOptions } from "./model";
export { evaluate, type EvalOptions } from "./eval";
export {
  computeShadow,
  buildShadowEvents,
  type ShadowReport,
  type ShadowJobComparison,
  type ShadowRankedEvent,
} from "./shadow";
export { stableHash, stableStringify } from "./hash";

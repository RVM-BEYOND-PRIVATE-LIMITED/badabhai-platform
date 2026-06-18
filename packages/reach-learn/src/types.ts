/**
 * @badabhai/reach-learn — LEARN layer types (ADR-0017).
 *
 * OFFLINE-FIRST. These types describe the pipeline that turns the PII-free `events`
 * stream into a bounded, versioned {@link WeightProfile} that the deterministic RANK
 * core (ADR-0006) consumes through its existing dial seam. The model ASSISTS (it
 * calibrates the six weights); the engine + caps DECIDE. No LLM. No live influence.
 *
 * PII boundary: nothing here carries a phone, name, address, or employer. `workerId`
 * / `jobId` are opaque UUIDs used ONLY as join/group keys — they NEVER enter a
 * {@link FeatureVector} (see features.ts allowlist + fail-closed assertion).
 */
import type { JobSpec, ReachSignal, WorkerSignals } from "@badabhai/reach-engine";

/** The six deterministic RANK signals — the ONLY learnable weight axes (ADR-0006). */
export const SIGNALS = [
  "role",
  "distance",
  "experience",
  "pay",
  "availability",
  "activity",
] as const satisfies readonly ReachSignal[];

export type SignalKey = (typeof SIGNALS)[number];

/** A 0..1 weight per signal. Same shape as the engine's `WEIGHTS` const. */
export type WeightVector = Record<SignalKey, number>;

/**
 * A PII-free event row as read from the `events` table. The pipeline only ever reads
 * `feed.shown` / `application.submitted` / `application.skipped`. Payloads are
 * ids/enums/derived-signals only (invariant #2) — asserted fail-closed on ingest.
 */
export interface LearnEvent {
  event_name: string;
  payload: Record<string, unknown>;
  /** ISO-8601; the ONLY ordering key (temporal split). */
  created_at: string;
  correlation_id?: string | null;
}

/**
 * Point-in-time signal snapshot — the engine input types (already PII-free: ids,
 * coarse city-centroid geo, bands). Used to reconstruct the six signal components
 * for an impression deterministically (ADR-0017 Decision 2: recompute-from-snapshot
 * until `feed.shown` v2 carries the components). NO raw PII (no name/phone/precise geo).
 */
export interface SignalSnapshot {
  jobs: Record<string, JobSpec>;
  workers: Record<string, WorkerSignals>;
}

/** Implicit-feedback label derived from `application.*` (positive = applied). */
export type Label = 0 | 1;

/**
 * One assembled training/eval row: a (worker-feed query, job item) pair with its
 * PII-free feature vector and label. `groupKey` is the query (the worker's feed) for
 * grouped ranking metrics; `workerId`/`jobId` are kept for the guardrail join ONLY,
 * never as model features.
 */
export interface TrainingRow {
  /** Query/group id for ranking metrics — the worker's feed. Opaque uuid (NOT a feature). */
  groupKey: string;
  workerId: string;
  jobId: string;
  /** The six signal raws (0..1) — the model's ONLY inputs. */
  features: FeatureVector;
  label: Label;
  /** 1-based rank the item was shown at (for IPW position-bias correction). */
  rankShown: number;
  /** ISO-8601 impression time (temporal split). */
  shownAt: string;
}

/** The model's feature vector — STRICTLY the six derived signal raws. No ids, no PII. */
export type FeatureVector = Record<SignalKey, number>;

/** Reproducibility manifest pinned to every dataset/model run (ADR-0017 Decision 2). */
export interface DatasetManifest {
  /** Inclusive event window used. */
  windowStart: string;
  windowEnd: string;
  /** Temporal split cutoff: rows before → train, at/after → test. */
  splitCutoff: string;
  featureSpecHash: string;
  /** Deterministic seed (the pipeline is seedless-deterministic; recorded for audit). */
  seed: number;
  rowCount: number;
  trainCount: number;
  testCount: number;
  queryCount: number;
}

export interface Dataset {
  train: TrainingRow[];
  test: TrainingRow[];
  manifest: DatasetManifest;
}

/**
 * The model output: a bounded, versioned, content-signed calibration of the six
 * weights. This is the ONLY thing LEARN feeds to the engine — consumed exactly like
 * `WEIGHTS`/`RankOptions`. It cannot filter, decide, or zero a signal (see model.ts
 * clamps). Off by default; promotion to live is a SEPARATE human gate (Decision 6).
 */
export interface WeightProfile {
  /** Monotonic version (e.g. "wp-1"). */
  version: string;
  /** The calibrated six weights, renormalized to sum 1.0. */
  weights: WeightVector;
  /** SHA-256 of `{weights, datasetManifestHash}` — the "signature" / integrity ref. */
  signature: string;
  /** Hash of the DatasetManifest the profile was trained on. */
  datasetManifestHash: string;
  createdAt: string;
}

/** Per-metric baseline-vs-learned comparison. */
export interface MetricPair {
  baseline: number;
  learned: number;
  /** learned - baseline (positive = improvement for NDCG/MAP/MRR). */
  delta: number;
}

/** The measured "widen, never narrow" guardrail result (ADR-0017 Decision 5). */
export interface GuardrailResult {
  /** min over workers of exposure_learned/exposure_baseline (1.0 = unchanged). */
  minExposureRatio: number;
  /** Workers whose exposure fell below the (1-epsilon) floor. MUST be empty to pass. */
  workersBelowFloor: string[];
  /** Any worker with baseline exposure > 0 driven to 0 by LEARN. MUST be false. */
  anyWorkerZeroed: boolean;
  /** Cold/sparse-profile cohort: median exposure delta (learned-baseline). Target >= 0. */
  coldCohortMedianDelta: number;
  /** Structural: the ranked SET is identical baseline vs learned (reorder-only). */
  setMonotonicityHolds: boolean;
  /** Per-worker exposure floor used (epsilon). */
  epsilon: number;
  /** k used for the top-k visibility secondary metric. */
  topK: number;
  /** Secondary: workers gaining vs losing top-k visibility. */
  topKGained: number;
  topKLost: number;
  pass: boolean;
}

/** Full offline eval result (held-out). `pass` gates promotion to shadow. */
export interface EvalResult {
  ndcg: MetricPair;
  map: MetricPair;
  mrr: MetricPair;
  /** k for NDCG@k / the metrics. */
  k: number;
  /** Whether position-bias IPW correction was applied. */
  ipwCorrected: boolean;
  guardrail: GuardrailResult;
  queryCount: number;
  /** PASS only if ranking quality improved (>= baseline) AND the guardrail passed. */
  pass: boolean;
}

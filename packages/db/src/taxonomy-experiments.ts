/**
 * The taxonomy EXPERIMENT registry — one immutable record per measured run.
 *
 * ---------------------------------------------------------------------------
 * WHY A REGISTRY AND NOT JUST A LOG LINE
 * ---------------------------------------------------------------------------
 * Phase 5 produced a real baseline (R@1 99.1%, MRR 0.996) that then had to be defended
 * against every later change — and the only copy of it was terminal scrollback plus a
 * session-scoped scratch file. That is not a baseline; it is a memory. A measurement that
 * cannot be re-read six weeks later cannot be regressed against, and "the number moved"
 * becomes unanswerable because nobody can say what the old number was measured WITH.
 *
 * So every run writes a record naming its own instrument: which evaluator semantics, which
 * fixture version, which embedding model, which ANN configuration. Two records are
 * comparable only when those agree, and the fields exist so that a reader can check rather
 * than assume.
 *
 * ---------------------------------------------------------------------------
 * IMMUTABILITY IS ENFORCED, NOT REQUESTED
 * ---------------------------------------------------------------------------
 * `writeExperimentRecord` REFUSES to overwrite an existing file. The Phase 5 baseline is the
 * reference every Phase 6 number is compared against, and the realistic way to lose it is
 * not malice — it is a re-run with the same run id after an edit, which would silently
 * replace the thing being compared against with the thing being compared. A run id collision
 * is therefore an error, and `--force` does not exist.
 *
 * ---------------------------------------------------------------------------
 * DISK IS THE SOURCE OF TRUTH; LANGFUSE IS A MIRROR
 * ---------------------------------------------------------------------------
 * The record is written to the repository first and always. The optional Langfuse push is a
 * convenience for comparing runs in a UI, and it is off unless asked for. Inverting that —
 * treating the observability backend as the store — would make a measurement depend on a
 * third party being reachable and credentialed, which is the same failure mode the harness
 * already refuses for the metrics themselves.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CorpusFingerprint } from "./corpus-fingerprint";
import { TAXONOMY_DATA_DIR } from "./taxonomy-corpus";

/** Where records live. One directory per experiment, one file per run. */
export const EXPERIMENTS_DIR = join(TAXONOMY_DATA_DIR, "eval", "experiments");

/**
 * The closed set of experiments. Closed on purpose: an ad-hoc experiment id typed at a
 * prompt produces a directory nobody looks in again, and the value of the registry is that
 * the set of things being compared is itself reviewable.
 */
export const EXPERIMENTS = {
  "EXP-BASELINE": "Phase 5 first real embedding run. Evaluator v1 semantics, fixture v1. IMMUTABLE REFERENCE.",
  "EXP-EVAL-CORRECTION": "Phase 6 measurement correction. Same embeddings, same queries; corrected evaluator/fixture.",
  "EXP-ANN-DEFAULT": "Scale simulation at the stock ANN configuration.",
  "EXP-ANN-EF-SEARCH": "Scale simulation sweeping hnsw.ef_search.",
  "EXP-ANN-ITERATIVE-SCAN": "Scale simulation with hnsw.iterative_scan enabled (pgvector >= 0.8).",
  // ── Phase 8 ────────────────────────────────────────────────────────────
  // EXP-EVAL-CORRECTION is NOT reused for the post-Gate-B baseline even though the
  // instrument is identical (evaluator v2, fixture v2). That experiment answers "what did
  // correcting the metric change"; this one answers "what did embedding the shipped
  // catalogue change". Filing the second under the first would leave two records in one
  // directory whose difference has two candidate explanations and no way to tell them apart.
  "EXP-P8-BASELINE": "Phase 8 post-Gate-B baseline. Evaluator v2, fixture v2, complete 295-alias corpus.",
  "EXP-P8-CANONICAL-LABEL":
    "Phase 8 offline simulation: add each skill's own canonical label_en where absent from its aliases.",
  // ── Phase 9 ────────────────────────────────────────────────────────────
  // Filed separately from EXP-P8-BASELINE because the INSTRUMENT changed, not the corpus:
  // fixture v3 adds 41 reviewed paraphrases to v2's 127 cases. Comparing a v3 number against
  // a v2 number measures the fixture, not retrieval, and the whole point of keeping the two
  // records apart is that nobody can accidentally read one as the other.
  "EXP-P9-TRAINER-V3":
    "Phase 9 Stage D. Evaluator v2, fixture v3 (127 v2 cases + 41 reviewed trainer paraphrases). Establishes whether the harder instrument still scores 1.0 before any baseline is re-pointed.",
} as const;
export type ExperimentId = keyof typeof EXPERIMENTS;

export function isExperimentId(v: string): v is ExperimentId {
  return Object.prototype.hasOwnProperty.call(EXPERIMENTS, v);
}

/**
 * What every experiment records, whatever kind of experiment it is.
 *
 * Nullable fields are null when NOT MEASURED — never zero, and never an estimate promoted
 * into a measured slot. `cost_inr_estimated` is separate from `cost_inr_metered` for that
 * reason: the provider returns no price for this model, so the only honest metered value is
 * null and the ai-service's own estimate must not be allowed to impersonate it.
 */
export interface ExperimentRecord {
  experiment: ExperimentId;
  run_id: string;
  /** ISO-8601. Supplied by the caller so the record itself stays a pure value. */
  recorded_at: string;
  /** Free-text, one line: what this run was for. */
  purpose: string;

  // ── instrument identity: two records are comparable only if these agree ──
  /** Evaluator SEMANTICS version — see EVALUATOR_VERSION. */
  evaluator_version: number;
  fixture_id: string | null;
  fixture_version: number | null;
  corpus_batch: string | null;
  /** The LLM/provider model, when one was called. */
  model: string | null;
  embedding_model: string | null;

  // ── what ran ────────────────────────────────────────────────────────────
  query_count: number;
  failure_count: number;
  /** Wall clock for the whole run. NOT per-query latency; see the field note in callers. */
  latency_ms: number | null;

  // ── quality (null for infrastructure-only experiments) ──────────────────
  recall_at_1: number | null;
  recall_at_3: number | null;
  recall_at_5: number | null;
  mrr: number | null;

  // ── spend ───────────────────────────────────────────────────────────────
  input_tokens: number | null;
  cost_inr_metered: number | null;
  cost_inr_estimated: number | null;

  // ── ANN configuration in effect ─────────────────────────────────────────
  ann: AnnConfig;

  /**
   * WHICH CORPUS this run measured — the freshness proof `promote-skills` reads.
   *
   * Optional because records written before fingerprinting exist and must stay readable. They
   * simply cannot clear a freshness check, which is correct: absence is not currency, and
   * backfilling one would fabricate the proof the field exists to provide.
   *
   * It was missing from this interface while `promote-skills` already read
   * `sweepRecord.corpus_fingerprint`, so `RESOLVABLE_ABOVE_FLOOR` evidence was **stale by
   * construction** — the only producer of sweep records had nowhere to put the value. Adding
   * the field does not relax the check; a stale sweep still fails. It makes a satisfiable
   * check out of an unsatisfiable one.
   */
  corpus_fingerprint?: CorpusFingerprint | null;

  /** Anything experiment-specific. Kept as an open bag so a new experiment kind does not
   *  require a schema change to the shared record. */
  detail?: Record<string, unknown>;
  notes: string[];
}

/** The ANN knobs whose values change what a retrieval number MEANS. */
export interface AnnConfig {
  /** Rows in the searched table at measurement time — the variable the whole scale
   *  simulation exists to move. A recall figure without it is not interpretable. */
  corpus_rows: number | null;
  /** Did the plan ACTUALLY use the HNSW index? Read from EXPLAIN, never assumed from the
   *  presence of an index — at small row counts the planner seq-scans and the measurement
   *  is exact NN wearing an ANN label. */
  hnsw_used: boolean | null;
  ef_search: number | null;
  iterative_scan: string | null;
  k: number | null;
  alias_overfetch: number | null;
}

export const UNKNOWN_ANN: AnnConfig = {
  corpus_rows: null,
  hnsw_used: null,
  ef_search: null,
  iterative_scan: null,
  k: null,
  alias_overfetch: null,
};

/** Filesystem-safe form of a run id (they contain `:` from ISO timestamps). */
export function runFileName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length === 0) throw new Error("[experiments] run_id reduces to an empty file name");
  return `${safe}.json`;
}

/**
 * Persist one record. REFUSES to overwrite.
 *
 * Returns the path written. The caller prints it, because an experiment the operator cannot
 * find is not preserved in any useful sense.
 */
export function writeExperimentRecord(rec: ExperimentRecord, baseDir: string = EXPERIMENTS_DIR): string {
  if (!isExperimentId(rec.experiment)) {
    throw new Error(`[experiments] unknown experiment ${String(rec.experiment)}`);
  }
  const dir = join(baseDir, rec.experiment);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, runFileName(rec.run_id));
  if (existsSync(path)) {
    throw new Error(
      `[experiments] ${path} already exists. Experiment records are immutable — a repeated ` +
        `run_id would replace the measurement being compared against with the one doing the ` +
        `comparing. Use a new run_id.`,
    );
  }
  writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  return path;
}

/** Read every record for one experiment, oldest first by `recorded_at`. */
export function readExperiment(id: ExperimentId, baseDir: string = EXPERIMENTS_DIR): ExperimentRecord[] {
  const dir = join(baseDir, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ExperimentRecord)
    .sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : 0));
}

/**
 * A comparison between two runs, with the instrument difference stated FIRST.
 *
 * The whole point of Phase 6 is that a score moved for two different reasons — the model did
 * not change, the measurement did — and a bare before/after table cannot express that. So a
 * comparison always carries `comparable`, and when it is false the deltas are still shown but
 * labelled as spanning an instrument change.
 */
export interface ExperimentComparison {
  from: string;
  to: string;
  comparable: boolean;
  instrument_changes: string[];
  delta_recall_at_1: number | null;
  delta_mrr: number | null;
}

export function compareExperiments(a: ExperimentRecord, b: ExperimentRecord): ExperimentComparison {
  const changes: string[] = [];
  if (a.evaluator_version !== b.evaluator_version) {
    changes.push(`evaluator_version ${a.evaluator_version} -> ${b.evaluator_version}`);
  }
  if (a.fixture_version !== b.fixture_version || a.fixture_id !== b.fixture_id) {
    changes.push(`fixture ${a.fixture_id}@v${a.fixture_version} -> ${b.fixture_id}@v${b.fixture_version}`);
  }
  if (a.embedding_model !== b.embedding_model) {
    changes.push(`embedding_model ${a.embedding_model} -> ${b.embedding_model}`);
  }
  if (a.corpus_batch !== b.corpus_batch) changes.push(`corpus_batch ${a.corpus_batch} -> ${b.corpus_batch}`);
  if (a.ann.corpus_rows !== b.ann.corpus_rows) {
    changes.push(`corpus_rows ${a.ann.corpus_rows} -> ${b.ann.corpus_rows}`);
  }
  if (a.ann.hnsw_used !== b.ann.hnsw_used) changes.push(`hnsw_used ${a.ann.hnsw_used} -> ${b.ann.hnsw_used}`);
  if (a.ann.ef_search !== b.ann.ef_search) changes.push(`ef_search ${a.ann.ef_search} -> ${b.ann.ef_search}`);
  if (a.ann.iterative_scan !== b.ann.iterative_scan) {
    changes.push(`iterative_scan ${a.ann.iterative_scan} -> ${b.ann.iterative_scan}`);
  }
  const delta = (x: number | null, y: number | null): number | null =>
    x === null || y === null ? null : Math.round((y - x) * 10_000) / 10_000;
  return {
    from: a.run_id,
    to: b.run_id,
    comparable: changes.length === 0,
    instrument_changes: changes,
    delta_recall_at_1: delta(a.recall_at_1, b.recall_at_1),
    delta_mrr: delta(a.mrr, b.mrr),
  };
}

// ===========================================================================
// Optional Langfuse mirror
// ===========================================================================

export type LangfusePushResult =
  | { status: "LANGFUSE_NOT_CONFIGURED" }
  | { status: "PUSHED"; traceId: string }
  | { status: "FAILED"; reason: string };

/**
 * Mirror one record into Langfuse as a trace, so runs are comparable in the UI alongside the
 * embedding traces they came from.
 *
 * CREDENTIAL-SAFE BY CONSTRUCTION: absent keys return LANGFUSE_NOT_CONFIGURED and the caller
 * carries on — the disk record is already written, so observability being down or unfunded
 * can never decide whether a measurement is preserved. A push FAILURE is likewise reported,
 * never thrown: losing a mirror must not fail a run whose real output is on disk.
 *
 * Uses the public ingestion endpoint over plain `fetch` rather than the Langfuse SDK. This
 * package has no AI provider credentials and gains none here — Langfuse keys are
 * observability credentials, already present for the status probe the harness has always
 * done, and they are read from the environment and sent only to the configured Langfuse host.
 */
export async function pushExperimentToLangfuse(
  rec: ExperimentRecord,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LangfusePushResult> {
  const pk = env.LANGFUSE_PUBLIC_KEY;
  const sk = env.LANGFUSE_SECRET_KEY;
  if (!pk || !sk) return { status: "LANGFUSE_NOT_CONFIGURED" };
  const base = env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com";
  const traceId = `taxonomy-${rec.experiment}-${runFileName(rec.run_id).replace(/\.json$/, "")}`.slice(0, 200);
  const body = {
    batch: [
      {
        id: `${traceId}-evt`,
        type: "trace-create",
        timestamp: rec.recorded_at,
        body: {
          id: traceId,
          name: `taxonomy-experiment:${rec.experiment}`,
          timestamp: rec.recorded_at,
          tags: ["feature:taxonomy", "experiment", rec.experiment],
          // The whole record. Scores and configuration travel together so a UI comparison
          // cannot show a number without the instrument that produced it.
          metadata: rec as unknown as Record<string, unknown>,
        },
      },
    ],
  };
  try {
    const resp = await fetchImpl(`${base}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { status: "FAILED", reason: `HTTP ${resp.status}` };
    return { status: "PUSHED", traceId };
  } catch (e) {
    return { status: "FAILED", reason: e instanceof Error ? e.name : "unknown" };
  }
}

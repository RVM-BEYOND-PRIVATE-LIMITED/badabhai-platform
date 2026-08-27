/**
 * The NO_REGRESSION evidence path — and the two defects that kept it unsatisfiable.
 *
 * Both were the same shape: a value that existed, was computed, and never reached the artifact
 * the gate reads.
 *
 *   1. `ExperimentRecord.corpus_fingerprint` was added when the floor sweep started stamping
 *      one. The EVALUATION computed it too — it is on the run record and has been printed for
 *      weeks — and then dropped it on the way into the experiment record, which is the only
 *      artifact `judgeRegression` ever sees. Every evaluation therefore reached the gate with
 *      `corpus_fingerprint === undefined`, which the gate correctly refuses.
 *   2. `audit-gate-evidence.ts` declared its own `DEFAULT_FIXTURE = retrieval-v3` while
 *      `promote-skills` imports the real one, which is **v2**. The audit reported the gate's
 *      answer under a fixture the gate does not use, and published "EVAL_COVERED PASS, 0 of 96
 *      uncovered" when the default blocks 41.
 *
 * Both are pinned here by reading the source and the committed record, because both were
 * invisible to every runtime assertion: the numbers were all individually correct.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ACTIVATION_SEQUENCE } from "./activation-sequence";
import { judgeRegression, REGRESSION_BASELINE } from "./promote-skills";
import { EXPERIMENTS, type ExperimentRecord } from "./taxonomy-experiments";
import { DEFAULT_FIXTURE } from "./taxonomy-retrieval-eval";

const SRC = __dirname;
const FRESH_DIR = join(SRC, "..", "data", "taxonomy", "eval", "experiments", "EXP-P9-REGRESSION-FRESH");

function freshRecord(): ExperimentRecord & {
  corpus_fingerprint?: unknown;
  detail?: { query_embed_cache?: { hits: number; misses: number } | null };
} {
  const files = readdirSync(FRESH_DIR)
    .filter((f) => f.startsWith("eval-") && f.endsWith(".json"))
    .sort();
  const last = files[files.length - 1];
  expect(last, "no EXP-P9-REGRESSION-FRESH evaluation on disk").toBeDefined();
  return JSON.parse(readFileSync(join(FRESH_DIR, last!), "utf8")) as ReturnType<typeof freshRecord>;
}

// ---------------------------------------------------------------------------
describe("defect 1 — the evaluation never carried the fingerprint the gate reads", () => {
  it("the evaluator now copies corpus_fingerprint onto the EXPERIMENT record", () => {
    // Source-level, because the value being present on the RUN record was never the problem.
    const src = readFileSync(join(SRC, "taxonomy-retrieval-eval.ts"), "utf8");
    expect(src).toMatch(/corpus_fingerprint:\s*record\.corpus_fingerprint/);
  });

  it("and the committed fresh record actually has one", () => {
    const r = freshRecord();
    expect(r.corpus_fingerprint).toBeTruthy();
    expect(Object.keys(r.corpus_fingerprint as object)).toContain("skill_alias");
  });

  it("so judgeRegression gets PAST freshness — and now PASSES outright", () => {
    // This assertion has moved twice in one day, and each move is the point. It first read
    // `stale === true` (the defect). Then `stale === false, passed === false` (freshness fixed,
    // GP-04 still regressing). Now the GP-04 alias has landed and the strict gate simply
    // passes — against an UNCHANGED 1.0/1.0 baseline.
    const r = freshRecord();
    const v = judgeRegression(r, r.corpus_fingerprint as never);
    expect(v.stale, "freshness should no longer be the blocker").toBe(false);
    expect(v.drift).toEqual([]);
    expect(v.passed).toBe(true);
    expect(v.detail).toMatch(/meets the reference/);
  });

  it("it meets the bar exactly, on the same instrument, with the baseline untouched", () => {
    const r = freshRecord();
    expect(r.fixture_version).toBe(REGRESSION_BASELINE.fixture_version);
    expect(r.evaluator_version).toBe(REGRESSION_BASELINE.evaluator_version);
    expect(r.recall_at_1).toBe(1);
    expect(r.mrr).toBe(1);
    expect(r.query_count).toBe(123);
    // THE ASSERTION THAT MATTERS MOST. The gate passes because the CORPUS improved, not because
    // the reference moved. If anyone ever "fixes" a future regression by editing this constant,
    // this line is what fails.
    expect(REGRESSION_BASELINE.recall_at_1).toBe(1.0);
    expect(REGRESSION_BASELINE.mrr).toBe(1.0);
  });

  it("a record with NO fingerprint is still refused — the fix did not relax the gate", () => {
    const r = freshRecord();
    const stripped = { ...r, corpus_fingerprint: undefined };
    const v = judgeRegression(stripped, r.corpus_fingerprint as never);
    expect(v.stale).toBe(true);
    expect(v.detail).toMatch(/carries no corpus_fingerprint/);
  });
});

// ---------------------------------------------------------------------------
describe("the run was free, and says so", () => {
  it("127 cached, 0 paid, estimated cost 0", () => {
    const r = freshRecord();
    expect(r.detail?.query_embed_cache).toEqual({ hits: 127, misses: 0 });
    expect(r.cost_inr_estimated).toBe(0);
  });

  it("and still records WHICH model, so a free run is not a run without provenance", () => {
    // A fully cached run never touches the provider, so `model` would stay null unless the
    // cache's own key — which IS the corpus model — is written through.
    const r = freshRecord();
    expect(r.embedding_model).toBe("gemini-embedding-001");
  });

  it("the cache is opt-in: no flag, no behaviour change", () => {
    const src = readFileSync(join(SRC, "taxonomy-retrieval-eval.ts"), "utf8");
    expect(src).toContain('const useCache = argv.includes("--cache")');
    // A miss must still go through the provider path so the mock and budget guards apply.
    expect(src).toMatch(/fetchVector: async \(text: string\) => \{[\s\S]{0,200}embedViaProvider/);
  });

  it("EXP-P9-REGRESSION-FRESH is a REGISTERED experiment, not an ad-hoc directory", () => {
    expect(Object.keys(EXPERIMENTS)).toContain("EXP-P9-REGRESSION-FRESH");
    expect(freshRecord().experiment).toBe("EXP-P9-REGRESSION-FRESH");
  });
});

// ---------------------------------------------------------------------------
describe("defect 2 — two constants named DEFAULT_FIXTURE", () => {
  it("the audit no longer declares a default fixture of its own", () => {
    const src = readFileSync(join(SRC, "audit-gate-evidence.ts"), "utf8");
    expect(src).not.toMatch(/const DEFAULT_FIXTURE\s*=/);
    expect(src).toContain('import { DEFAULT_FIXTURE } from "./taxonomy-retrieval-eval"');
  });

  it("and the real default is v2 — the fixture under which EVAL_COVERED blocks 41", () => {
    // Pinned as a fact rather than a preference. If someone changes the default to v3, this
    // fails and they must revisit the promote command and the register together.
    expect(DEFAULT_FIXTURE.replace(/\\/g, "/")).toMatch(/data\/taxonomy\/eval\/retrieval-v2\.jsonl$/);
  });

  it("so the documented PROMOTE command names --fixture explicitly", () => {
    // Omitting it was a live defect in the activation plan: the documented command would have
    // been run against v2 and blocked 41 of the 96 it claims to promote.
    const promote = ACTIVATION_SEQUENCE.find((s) => s.id === "PROMOTE")!;
    expect(promote.runner).toContain("--fixture");
    expect(promote.runner).toContain("retrieval-v3.jsonl");
  });

  it("and both fixtures still exist, because the audit compares them", () => {
    for (const f of ["retrieval-v2.jsonl", "retrieval-v3.jsonl"]) {
      expect(existsSync(join(SRC, "..", "data", "taxonomy", "eval", f)), f).toBe(true);
    }
  });
});

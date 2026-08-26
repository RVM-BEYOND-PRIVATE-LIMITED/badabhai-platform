/**
 * The gates, and the one repair made to them.
 *
 * The repair needs stating precisely, because "made a gate satisfiable" and "weakened a gate"
 * look alike from a distance. `promote-skills` computes
 * `no_regression = regression.passed && !sweepStale`, and `sweepStale` reads
 * `sweepRecord.corpus_fingerprint` — a field `ExperimentRecord` did not have. The only producer
 * of sweep records therefore had nowhere to put the value, so **every sweep was stale on arrival
 * and no re-run could change that.** Adding the field relaxes nothing: a stale sweep still fails,
 * the 1.0/1.0 bar is untouched, and a record without a fingerprint still cannot prove currency.
 *
 * The tests at the bottom assert the bar did not move, so this claim is checkable rather than
 * asserted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyFloorFailure } from "./audit-gate-evidence";
import { missingProvenance } from "./evidence-provenance";
import { CANONICALIZATION_FLOOR, CRITERIA, REGRESSION_BASELINE } from "./promote-skills";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");

describe("classifyFloorFailure — one gate name, three different problems", () => {
  it("a correct resolution at or above the floor passes", () => {
    expect(classifyFloorFailure(0.75, false, 0.75)).toBe("PASSES");
    expect(classifyFloorFailure(0.9, false, 0.75)).toBe("PASSES");
  });

  it("found, correct, and not confidently — a CORPUS problem", () => {
    expect(classifyFloorFailure(0.74, false, 0.75)).toBe("CORRECT_BUT_BELOW_FLOOR");
  });

  it("never asked about — an INSTRUMENT problem, not a retrieval one", () => {
    expect(classifyFloorFailure(undefined, false, 0.75)).toBe("NO_CORRECT_CASE_IN_SWEEP");
  });

  it("present only as somebody else's wrong answer — the worst of the three", () => {
    // A skill that has demonstrated it can be confidently mis-assigned, and never demonstrated
    // it can be found. Merging this into "no case" would hide it.
    expect(classifyFloorFailure(undefined, true, 0.75)).toBe("ONLY_EVER_A_WRONG_ANSWER");
  });
});

// ---------------------------------------------------------------------------
interface Artifact {
  ai_spend_inr: number;
  floor: number;
  regression_baseline: { recall_at_1: number; mrr: number; fixture_version: number; evaluator_version: number };
  evaluation_records: {
    path: string;
    fixture_version: number | null;
    recall_at_1: number | null;
    mrr: number | null;
    has_fingerprint: boolean;
    passed: boolean;
    stale: boolean;
    detail: string;
  }[];
  no_regression_independent_blockers: string[];
  floor_sweep_records: { path: string; has_fingerprint: boolean; cases: number }[];
  resolvable_above_floor: {
    by_cause: Record<string, number>;
    correct_but_below_floor: { skill_id: string; best_correct: number }[];
    no_correct_case_in_sweep: string[];
  };
  eval_covered_by_fixture: Record<string, { cases: number; missing: number }>;
  green_path: { gate: string; actor: string; what: string; status: string }[];
  production_mutation_performed: boolean;
}

const art = JSON.parse(readFileSync(join(DOCS, "gate-evidence.json"), "utf8")) as Artifact;

describe("NO_REGRESSION — why it fails, all of it at once", () => {
  it("carries provenance, cost nothing, wrote nothing", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
  });

  it("an evaluation scoring EXACTLY 1.0/1.0 on fixture v2 already exists", () => {
    // The baseline's own source. So the gate is not blocked on the SCORE being unreachable —
    // it was reached once, before Gate B embedded the shipped catalogue.
    const perfect = art.evaluation_records.filter(
      (e) => e.fixture_version === 2 && e.recall_at_1 === 1 && e.mrr === 1,
    );
    expect(perfect.length).toBeGreaterThan(0);
    expect(perfect[0]!.passed).toBe(false);
    expect(perfect[0]!.stale).toBe(true);
    expect(perfect[0]!.detail).toMatch(/no corpus_fingerprint/);
  });

  it("EXACTLY ONE SIDE now carries a corpus_fingerprint — the evaluation, as of 2026-08-26", () => {
    // This assertion used to read "NOT ONE record of any kind carries one", which was the
    // defect: the evaluator computed the fingerprint and dropped it on the way into the
    // experiment record, the only artifact the gate reads. Fixed, and re-measured at ZERO
    // cost because every fixture-v2 query vector was already in the local embed cache.
    //
    // Inverted rather than deleted. It now pins the halfway state honestly: one side done,
    // one side outstanding — which is exactly what stops "the fingerprint work is finished"
    // from being said before the sweep is re-run.
    expect(art.evaluation_records.some((e) => e.has_fingerprint)).toBe(true);
    expect(art.floor_sweep_records.every((s) => !s.has_fingerprint)).toBe(true);
  });

  it("the STRUCTURAL blocker is named: a sweep could not carry one at all", () => {
    const structural = art.no_regression_independent_blockers.find((b) => b.includes("STRUCTURAL"));
    expect(structural).toBeDefined();
    expect(structural).toMatch(/no_regression = regression\.passed && !sweepStale/);
  });

  it("the freshness blocker is marked NOT WAIVABLE", () => {
    expect(art.no_regression_independent_blockers.join(" ")).toMatch(/NOT WAIVABLE/);
  });

  it("and a real regression is on record — 0.9912 on v2, not a measurement artifact", () => {
    const v2 = art.evaluation_records.filter((e) => e.fixture_version === 2 && e.recall_at_1 !== null);
    expect(v2.some((e) => e.recall_at_1 === 0.9912)).toBe(true);
  });
});

describe("RESOLVABLE_ABOVE_FLOOR — 34 failures, two distinct causes", () => {
  it("62 pass, 28 are below the floor while CORRECT, 6 were never asked about", () => {
    expect(art.resolvable_above_floor.by_cause).toEqual({
      PASSES: 62,
      CORRECT_BUT_BELOW_FLOOR: 28,
      NO_CORRECT_CASE_IN_SWEEP: 6,
      ONLY_EVER_A_WRONG_ANSWER: 0,
    });
  });

  it("62 + 34 = 96, so the two conventions the docs use are reconciled", () => {
    const c = art.resolvable_above_floor.by_cause;
    expect(c["PASSES"]! + c["CORRECT_BUT_BELOW_FLOOR"]! + c["NO_CORRECT_CASE_IN_SWEEP"]! + c["ONLY_EVER_A_WRONG_ANSWER"]!).toBe(96);
    // "62/96" in project-control is a PASS count; the runner's "34" is a FAIL count.
    expect(c["PASSES"]).toBe(62);
  });

  it("NOTHING is only ever a wrong answer — the worst category is empty", () => {
    expect(art.resolvable_above_floor.by_cause["ONLY_EVER_A_WRONG_ANSWER"]).toBe(0);
  });

  it("every below-floor skill is genuinely below it, and the worst is 0.5986", () => {
    const rows = art.resolvable_above_floor.correct_but_below_floor;
    expect(rows).toHaveLength(28);
    for (const r of rows) expect(r.best_correct, r.skill_id).toBeLessThan(CANONICALIZATION_FLOOR);
    expect(Math.min(...rows.map((r) => r.best_correct))).toBeCloseTo(0.5986, 4);
  });
});

describe("EVAL_COVERED — the gate depends on which fixture, and the docs quote the other one", () => {
  it("v3 leaves ZERO promotable skills uncovered; v2 leaves 41", () => {
    expect(art.eval_covered_by_fixture["data/taxonomy/eval/retrieval-v3.jsonl"]!.missing).toBe(0);
    expect(art.eval_covered_by_fixture["data/taxonomy/eval/retrieval-v2.jsonl"]!.missing).toBe(41);
  });

  it("so no fixture needs authoring, and none was", () => {
    // D6-1 stands: agent-authored paraphrases must never silently become ground truth. This
    // gate does not require any, which is worth pinning so nobody writes some to "fix" it.
    expect(art.eval_covered_by_fixture["data/taxonomy/eval/retrieval-v3.jsonl"]!.cases).toBe(168);
  });
});

describe("the green path names who can take each step", () => {
  it("every step is attributed to ENGINEERING, AI SPEND, OWNER or NONE", () => {
    for (const g of art.green_path) {
      expect(["ENGINEERING", "AI SPEND", "OWNER or CORPUS FIX", "ENGINEERING + OWNER", "NONE"]).toContain(
        g.actor,
      );
    }
  });

  it("and says plainly that a waiver cannot substitute for the spend step", () => {
    const step3 = art.green_path.find((g) => g.status.includes("WAIVER CANNOT CLEAR"));
    expect(step3).toBeDefined();
    expect(step3!.actor).toBe("OWNER or CORPUS FIX");
  });
});

describe("NOTHING about the bar moved", () => {
  it("REGRESSION_BASELINE is untouched — 1.0 / 1.0, evaluator v2, fixture v2", () => {
    expect(REGRESSION_BASELINE.recall_at_1).toBe(1.0);
    expect(REGRESSION_BASELINE.mrr).toBe(1.0);
    expect(REGRESSION_BASELINE.evaluator_version).toBe(2);
    expect(REGRESSION_BASELINE.fixture_version).toBe(2);
    expect(art.regression_baseline).toMatchObject({ recall_at_1: 1, mrr: 1, fixture_version: 2 });
  });

  it("the floor is still 0.75 and the criteria set is still the closed seven", () => {
    expect(CANONICALIZATION_FLOOR).toBe(0.75);
    expect(art.floor).toBe(0.75);
    expect(CRITERIA).toHaveLength(7);
  });

  it("the freshness rule still refuses a record with no fingerprint", () => {
    // The repair added a FIELD. It did not add an exemption.
    const src = readFileSync(join(__dirname, "promote-skills.ts"), "utf8");
    expect(src).toMatch(/carries no corpus_fingerprint/);
    expect(src).toMatch(/no_regression: regression\.passed && !sweepStale/);
  });

  it("and the floor sweep now stamps one, read AFTER the queries and never fabricated", () => {
    const src = readFileSync(join(__dirname, "taxonomy-floor-sweep.ts"), "utf8");
    expect(src).toContain("corpus_fingerprint: corpusFingerprint");
    expect(src).toMatch(/never fabricated/);
    // Null on failure: an unreadable fingerprint must not become a passing one.
    expect(src).toMatch(/let corpusFingerprint: CorpusFingerprint \| null = null/);
  });
});

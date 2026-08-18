/**
 * The promotion POLICY, tested without a database.
 *
 * Promotion is the single operation that makes a skill publishable — since Phase 7 Gate A,
 * `skill.status = 'active'` is what `SkillsRepository.canonicalAliasRows` filters on. So the
 * interesting assertions here are all about REFUSING: refusing to promote something
 * unmeasured, unembedded, unreachable or already retired, refusing to promote a batch
 * partially, and refusing to overwrite the evidence of a previous run.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bestCorrectScores,
  blockingHistogram,
  CANONICALIZATION_FLOOR,
  CRITERIA,
  isCriterion,
  judge,
  judgeRegression,
  REGRESSION_BASELINE,
  reportPath,
  writeReport,
  type CandidateFacts,
  type Criterion,
  type PromotionReport,
} from "./promote-skills";

/** A candidate that passes everything. Each test breaks exactly one thing. */
const ok = (o: Partial<CandidateFacts> = {}): CandidateFacts => ({
  skill_id: "skill_x",
  status: "provisional",
  in_accepted_batch: true,
  active_edges: 2,
  aliases: 2,
  unembedded_aliases: 0,
  embedding_models: ["gemini-embedding-001"],
  eval_covered: true,
  best_correct_score: 0.92,
  no_regression: true,
  regression_detail: "meets the reference",
  ...o,
});

const blocked = (f: CandidateFacts, waived?: Criterion[]): Criterion[] =>
  judge(f, new Set(waived ?? [])).blocking;

describe("the criteria set", () => {
  it("is closed", () => {
    expect(isCriterion("EVAL_COVERED")).toBe(true);
    expect(isCriterion("LOOKS_FINE")).toBe(false);
    expect(CRITERIA).toHaveLength(7);
  });

  it("judges EVERY criterion on every candidate, pass or fail", () => {
    // A bare eligible:true/false hides which rule did the work, and at review time the
    // binding rule is the only interesting part.
    const v = judge(ok());
    expect(v.criteria.map((c) => c.criterion).sort()).toEqual([...CRITERIA].sort());
    expect(v.criteria.every((c) => c.detail.length > 0)).toBe(true);
  });
});

describe("judge — a fully-qualified candidate", () => {
  it("is eligible", () => {
    const v = judge(ok());
    expect(v.eligible).toBe(true);
    expect(v.blocking).toEqual([]);
  });
});

describe("judge — IS_PROVISIONAL", () => {
  it("refuses a skill that is already active (a silent no-op otherwise)", () => {
    expect(blocked(ok({ status: "active" }))).toContain("IS_PROVISIONAL");
  });

  it("refuses to RESURRECT a deprecated skill", () => {
    // A human retired this. Promotion must never be the thing that undoes that, and
    // "deprecated" must not be quietly skipped as if it were absent.
    expect(blocked(ok({ status: "deprecated" }))).toContain("IS_PROVISIONAL");
  });

  it("refuses a skill id with no row at all", () => {
    const v = judge(ok({ status: null }));
    expect(v.blocking).toContain("IS_PROVISIONAL");
    expect(v.criteria.find((c) => c.criterion === "IS_PROVISIONAL")?.detail).toMatch(/not found/);
  });
});

describe("judge — ACTIVE_EDGE", () => {
  it("refuses a skill with no active edge — it would be unreachable anyway", () => {
    // Retrieval scopes through job_domain_skill. Promoting an unwired skill changes nothing
    // except making the audit trail claim something is live when it cannot be returned.
    expect(blocked(ok({ active_edges: 0 }))).toContain("ACTIVE_EDGE");
  });

  it("accepts a single edge", () => {
    expect(blocked(ok({ active_edges: 1 }))).toEqual([]);
  });
});

describe("judge — FULLY_EMBEDDED", () => {
  it("refuses a partially embedded skill, and says how many are missing", () => {
    // Live and findable only through whichever aliases happen to have vectors is the worst
    // of both worlds — it looks healthy and silently under-retrieves.
    const v = judge(ok({ aliases: 3, unembedded_aliases: 1 }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toBe(
      "1 of 3 aliases unembedded",
    );
  });

  it("refuses a skill embedded with the MOCK sentinel", () => {
    const v = judge(ok({ embedding_models: ["mock-embedding"] }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toMatch(/sentinel/);
  });

  it("refuses a skill whose aliases span TWO models", () => {
    // Every vector is real and the space is still incoherent — distances across two models
    // are not comparable, which a null-check cannot see.
    const v = judge(ok({ embedding_models: ["gemini-embedding-001", "text-embedding-3"] }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toMatch(/span 2 models/);
  });

  it("refuses a skill with no aliases at all", () => {
    // 0 unembedded of 0 aliases is vacuously "complete"; it is also unretrievable.
    const v = judge(ok({ aliases: 0, unembedded_aliases: 0, embedding_models: [] }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toBe("no aliases at all");
  });
});

describe("judge — EVAL_COVERED", () => {
  it("refuses a skill no evaluation case has ever exercised", () => {
    // The strict rule: promote only what has been measured. On the current corpus it admits
    // 61 of 98, which is exactly why it is named and waivable rather than silently assumed
    // in either direction.
    expect(blocked(ok({ eval_covered: false }))).toContain("EVAL_COVERED");
  });

  it("can be WAIVED, and the waiver is recorded on the criterion", () => {
    const v = judge(ok({ eval_covered: false }), new Set<Criterion>(["EVAL_COVERED"]));
    expect(v.eligible).toBe(true);
    expect(v.blocking).toEqual([]);
    const c = v.criteria.find((x) => x.criterion === "EVAL_COVERED");
    expect(c?.passed).toBe(false); // still FAILED...
    expect(c?.waived).toBe(true); // ...and the report says it was waived, not that it passed
  });

  it("a waiver does not excuse the OTHER criteria", () => {
    const v = judge(ok({ eval_covered: false, active_edges: 0 }), new Set<Criterion>(["EVAL_COVERED"]));
    expect(v.eligible).toBe(false);
    expect(v.blocking).toEqual(["ACTIVE_EDGE"]);
  });
});

describe("judge — GATE_ACCEPTED", () => {
  it("refuses a skill that is not in an accepted batch", () => {
    expect(blocked(ok({ in_accepted_batch: false }))).toContain("GATE_ACCEPTED");
  });
});

describe("judge — several failures at once", () => {
  it("names every blocking criterion, not just the first", () => {
    // An operator fixing one blocker at a time from a report that shows one blocker at a
    // time will run this five times.
    const v = judge(ok({ status: "active", active_edges: 0, eval_covered: false, unembedded_aliases: 1 }));
    expect(v.blocking.sort()).toEqual(
      ["ACTIVE_EDGE", "EVAL_COVERED", "FULLY_EMBEDDED", "IS_PROVISIONAL"].sort(),
    );
  });
});

describe("blockingHistogram", () => {
  it("tallies which criterion held back how many candidates", () => {
    const vs = [
      judge(ok({ eval_covered: false })),
      judge(ok({ eval_covered: false })),
      judge(ok({ active_edges: 0 })),
      judge(ok()),
    ];
    expect(blockingHistogram(vs)).toEqual({ ACTIVE_EDGE: 1, EVAL_COVERED: 2 });
  });

  it("is empty when everything is eligible", () => {
    expect(blockingHistogram([judge(ok()), judge(ok())])).toEqual({});
  });
});

describe("the audit report", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "promo-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const report = (o: Partial<PromotionReport> = {}): PromotionReport => ({
    script: "promote:skills",
    mode: "APPLY",
    generated_at: "2026-08-17T00:00:00.000Z",
    batch_dir: "batch_x",
    fixture: "retrieval-v2.jsonl",
    waived: [],
    floor: CANONICALIZATION_FLOOR,
    regression_baseline: { ...REGRESSION_BASELINE },
    regression: {
      passed: true,
      detail: "ok",
      observed_recall_at_1: 1,
      observed_mrr: 1,
      delta_recall_at_1: 0,
      delta_mrr: 0,
    },
    sweep_record: "sweep.json",
    eval_record: "eval.json",
    candidates: 1,
    eligible: 1,
    blocked: 0,
    promoted: ["skill_x"],
    skipped_concurrent: [],
    verdicts: [judge(ok())],
    notes: [],
    ...o,
  });

  it("writes a readable record", () => {
    const p = writeReport(report(), join(dir, "r.json"));
    const back = JSON.parse(readFileSync(p, "utf8")) as PromotionReport;
    expect(back.promoted).toEqual(["skill_x"]);
    expect(back.verdicts[0]?.criteria).toHaveLength(7);
  });

  it("REFUSES to overwrite — a promotion report is evidence, not a scratch file", () => {
    const p = join(dir, "r.json");
    writeReport(report(), p);
    expect(() => writeReport(report({ promoted: ["other"] }), p)).toThrow(/immutable evidence/);
  });

  it("makes an ISO stamp filesystem-safe", () => {
    expect(reportPath("2026-08-17T05:41:39.559Z", dir)).toBe(
      join(dir, "promotion-2026-08-17T05_41_39.559Z.json"),
    );
  });

  it("records enough to REVERT: the ids that actually moved", () => {
    // Reversibility rests entirely on this list, and it is the APPLIED set, not the eligible
    // set — a row the concurrency guard skipped was never promoted and must not be reverted.
    const r = report({ eligible: 2, promoted: ["a"], skipped_concurrent: ["b"] });
    const p = writeReport(r, join(dir, "r.json"));
    const back = JSON.parse(readFileSync(p, "utf8")) as PromotionReport;
    expect(back.promoted).toEqual(["a"]);
    expect(back.skipped_concurrent).toEqual(["b"]);
  });

  it("a PLAN report records that nothing moved", () => {
    const r = report({ mode: "PLAN", promoted: [] });
    const back = JSON.parse(readFileSync(writeReport(r, join(dir, "p.json")), "utf8")) as PromotionReport;
    expect(back.mode).toBe("PLAN");
    expect(back.promoted).toEqual([]);
  });

  it("carries the waiver list, so a waived promotion is never indistinguishable from a clean one", () => {
    const r = report({ waived: ["EVAL_COVERED"] });
    const back = JSON.parse(readFileSync(writeReport(r, join(dir, "w.json")), "utf8")) as PromotionReport;
    expect(back.waived).toEqual(["EVAL_COVERED"]);
  });
});

describe("the CURRENT corpus, judged", () => {
  it("blocks the 37 skills the fixture never exercises", () => {
    // A regression guard on the policy against real numbers: 98 candidates, 61 covered.
    // If someone loosens EVAL_COVERED, this is what changes.
    const covered = 61;
    const total = 98;
    const vs = [
      ...Array.from({ length: covered }, (_, i) => judge(ok({ skill_id: `c${i}` }))),
      ...Array.from({ length: total - covered }, (_, i) => judge(ok({ skill_id: `u${i}`, eval_covered: false }))),
    ];
    expect(vs.filter((v) => v.eligible)).toHaveLength(61);
    expect(blockingHistogram(vs)).toEqual({ EVAL_COVERED: 37 });
  });

  it("admits all 98 only when EVAL_COVERED is explicitly waived", () => {
    const w = new Set<Criterion>(["EVAL_COVERED"]);
    const vs = [
      ...Array.from({ length: 61 }, (_, i) => judge(ok({ skill_id: `c${i}` }), w)),
      ...Array.from({ length: 37 }, (_, i) => judge(ok({ skill_id: `u${i}`, eval_covered: false }), w)),
    ];
    expect(vs.filter((v) => v.eligible)).toHaveLength(98);
  });
});

// ===========================================================================
// Phase 8 safeguard 1: RESOLVABLE_ABOVE_FLOOR
// ===========================================================================
describe("judge — RESOLVABLE_ABOVE_FLOOR", () => {
  it("admits a skill whose best validated resolution clears the floor", () => {
    expect(blocked(ok({ best_correct_score: 0.92 }))).toEqual([]);
    expect(blocked(ok({ best_correct_score: CANONICALIZATION_FLOOR }))).toEqual([]); // inclusive
  });

  it("REFUSES a skill that would be live but permanently unassignable", () => {
    // The failure this gate exists for: every other criterion passes, the skill goes active,
    // and the canonicalization floor then rejects every match it could ever win. Gate C
    // measured 13 of 112 correct answers sitting below 0.75.
    const v = judge(ok({ best_correct_score: 0.7402 }));
    expect(v.blocking).toContain("RESOLVABLE_ABOVE_FLOOR");
    expect(v.criteria.find((c) => c.criterion === "RESOLVABLE_ABOVE_FLOOR")?.detail).toMatch(/BELOW/);
  });

  it("REFUSES a skill no validated query ever resolved to", () => {
    // Distinct from "scored low": there is no evidence at all. Silence is not a pass.
    const v = judge(ok({ best_correct_score: null }));
    expect(v.blocking).toContain("RESOLVABLE_ABOVE_FLOOR");
    expect(v.criteria.find((c) => c.criterion === "RESOLVABLE_ABOVE_FLOOR")?.detail).toMatch(/no validated query ever resolved/);
  });

  it("is judged against the floor that is actually running", () => {
    // If someone lowers CANONICALIZATION_FLOOR to make this gate pass, the constant is the
    // single place that happens, and it is pinned to the shipped config.
    expect(CANONICALIZATION_FLOOR).toBe(0.75);
  });
});

describe("bestCorrectScores — reading the floor sweep", () => {
  const rec = (cases: unknown[]) => ({ detail: { per_case: cases } });

  it("keeps each skill's BEST correct score", () => {
    const m = bestCorrectScores(
      rec([
        { top_skill_id: "a", score: 0.7, correct: true },
        { top_skill_id: "a", score: 0.93, correct: true },
        { top_skill_id: "b", score: 0.8, correct: true },
      ]),
    );
    expect(m.get("a")).toBe(0.93);
    expect(m.get("b")).toBe(0.8);
  });

  it("IGNORES high-scoring WRONG answers", () => {
    // A skill that confidently wins when it should not has demonstrated it can be
    // mis-assigned. Counting that as evidence FOR promoting it inverts the whole gate.
    const m = bestCorrectScores(rec([{ top_skill_id: "rival", score: 0.99, correct: false }]));
    expect(m.has("rival")).toBe(false);
  });

  it("ignores null scores and null skills", () => {
    const m = bestCorrectScores(
      rec([
        { top_skill_id: null, score: 0.9, correct: true },
        { top_skill_id: "a", score: null, correct: true },
      ]),
    );
    expect(m.size).toBe(0);
  });

  it("survives a record with no per_case detail rather than throwing mid-promotion", () => {
    expect(bestCorrectScores({}).size).toBe(0);
    expect(bestCorrectScores({ detail: {} }).size).toBe(0);
  });
});

// ===========================================================================
// Phase 8 safeguard 2: NO_REGRESSION
// ===========================================================================
describe("judgeRegression — no tolerance band, by design", () => {
  const evalRec = (o: Record<string, unknown> = {}) => ({
    recall_at_1: 1.0,
    mrr: 1.0,
    evaluator_version: 2,
    fixture_version: 2,
    ...o,
  });

  it("passes when the evaluation MEETS the reference exactly", () => {
    const v = judgeRegression(evalRec());
    expect(v.passed).toBe(true);
    expect(v.delta_recall_at_1).toBe(0);
  });

  it("BLOCKS on the smallest measurable drop — there is no allowance", () => {
    // The whole point. Any "block if it drops more than X" is a number nobody chose, and a
    // number chosen to let the current corpus through is a rubber stamp with arithmetic on it.
    const v = judgeRegression(evalRec({ recall_at_1: 0.9999 }));
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/REGRESSION/);
  });

  it("BLOCKS on the ACTUAL post-Gate-B numbers, and reports the delta", () => {
    // This gate is EXPECTED to fire today: Gate B embedded the shipped catalogue, which put
    // skill_turning into competition and cost case GP-04.
    const v = judgeRegression(evalRec({ recall_at_1: 0.9912, mrr: 0.9956 }));
    expect(v.passed).toBe(false);
    expect(v.delta_recall_at_1).toBeCloseTo(-0.0088, 6);
    expect(v.delta_mrr).toBeCloseTo(-0.0044, 6);
    expect(v.detail).toMatch(/Reported for review/);
  });

  it("BLOCKS on an MRR-only regression, even when Recall@1 holds", () => {
    // Recall@1 is rank-1 only; MRR is where a slip from rank 1 to rank 2 shows up. A gate
    // watching recall alone would miss the whole corpus degrading by one position.
    expect(judgeRegression(evalRec({ recall_at_1: 1.0, mrr: 0.97 })).passed).toBe(false);
  });

  it("REFUSES an evaluation taken with a different EVALUATOR — not comparable", () => {
    // A v1 number against the v2 reference is two different questions, and the delta would
    // be a measurement artifact dressed up as a safety verdict.
    const v = judgeRegression(evalRec({ evaluator_version: 1 }));
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/different questions/);
  });

  it("REFUSES an evaluation taken against a different FIXTURE version", () => {
    expect(judgeRegression(evalRec({ fixture_version: 1 })).passed).toBe(false);
  });

  it("REFUSES a record carrying no metrics — absence is not a pass", () => {
    expect(judgeRegression(evalRec({ recall_at_1: null, mrr: null })).passed).toBe(false);
    expect(judgeRegression(null).passed).toBe(false);
  });

  it("never reports passed=true on any malformed input", () => {
    for (const bad of [undefined, 0, "", [], {}, { recall_at_1: 1 }]) {
      expect(judgeRegression(bad).passed, `malformed input passed: ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("judge — NO_REGRESSION applies to every candidate in the batch", () => {
  it("blocks every candidate when the batch regresses", () => {
    // Promotion is all-or-nothing per batch, so the regression verdict is batch-level and is
    // reported on each candidate rather than buried in a preamble.
    const vs = [ok({ skill_id: "a" }), ok({ skill_id: "b" })].map((f) =>
      judge({ ...f, no_regression: false, regression_detail: "R@1 0.9912 (-0.0088)" }),
    );
    expect(vs.every((v) => v.blocking.includes("NO_REGRESSION"))).toBe(true);
    expect(blockingHistogram(vs)).toEqual({ NO_REGRESSION: 2 });
  });

  it("carries the regression detail onto the criterion so the report explains itself", () => {
    const v = judge(ok({ no_regression: false, regression_detail: "R@1 0.9912 (-0.0088)" }));
    expect(v.criteria.find((c) => c.criterion === "NO_REGRESSION")?.detail).toBe("R@1 0.9912 (-0.0088)");
  });

  it("can be waived, and the waiver is recorded rather than hidden", () => {
    const v = judge(
      ok({ no_regression: false, regression_detail: "R@1 0.9912" }),
      new Set<Criterion>(["NO_REGRESSION"]),
    );
    expect(v.eligible).toBe(true);
    const c = v.criteria.find((x) => x.criterion === "NO_REGRESSION");
    expect(c?.passed).toBe(false);
    expect(c?.waived).toBe(true);
  });
});

describe("the CURRENT corpus under BOTH new safeguards", () => {
  it("blocks the whole batch today, because Gate B caused a real regression", () => {
    // Regression guard on the policy against the measured state: 98 candidates, all blocked
    // by NO_REGRESSION regardless of their individual merits.
    const vs = Array.from({ length: 98 }, (_, i) =>
      judge(ok({ skill_id: `s${i}`, no_regression: false, regression_detail: "R@1 0.9912 (-0.0088)" })),
    );
    expect(vs.filter((v) => v.eligible)).toHaveLength(0);
    expect(blockingHistogram(vs)).toEqual({ NO_REGRESSION: 98 });
  });

  it("still blocks the 44 skills below the floor once the regression is waived", () => {
    // Gate C measured 54 of 98 skills with a validated resolution at/above 0.75.
    const w = new Set<Criterion>(["NO_REGRESSION"]);
    const vs = [
      ...Array.from({ length: 54 }, (_, i) =>
        judge(ok({ skill_id: `hi${i}`, best_correct_score: 0.9, no_regression: false }), w),
      ),
      ...Array.from({ length: 44 }, (_, i) =>
        judge(ok({ skill_id: `lo${i}`, best_correct_score: null, no_regression: false }), w),
      ),
    ];
    expect(vs.filter((v) => v.eligible)).toHaveLength(54);
    expect(blockingHistogram(vs)).toEqual({ RESOLVABLE_ABOVE_FLOOR: 44 });
  });
});

describe("judgeRegression — evidence must be CURRENT", () => {
  const rec = (o: Record<string, unknown> = {}) => ({
    recall_at_1: 1.0,
    mrr: 1.0,
    evaluator_version: 2,
    fixture_version: 2,
    recorded_at: "2026-08-17T12:00:00.000Z",
    ...o,
  });

  it("accepts an evaluation taken AFTER the corpus last changed", () => {
    const v = judgeRegression(rec(), new Date("2026-08-17T09:41:00.000Z"));
    expect(v.passed).toBe(true);
  });

  it("REFUSES an evaluation that PREDATES the corpus it is clearing", () => {
    // Caught in review of this gate. The first demonstration run passed NO_REGRESSION using
    // the pre-Gate-B record while the live corpus had already regressed to 0.9912 — the gate
    // reported PASS on evidence that could not possibly have seen the regression. Pointing at
    // an old record is the easiest way to defeat this gate without touching any code.
    const v = judgeRegression(
      rec({ recorded_at: "2026-08-17T06:33:38.652Z" }),
      new Date("2026-08-17T09:41:42.150Z"),
    );
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/PREDATES/);
  });

  it("REFUSES a record with no parsable recorded_at — it cannot prove it is current", () => {
    expect(judgeRegression(rec({ recorded_at: undefined }), new Date()).passed).toBe(false);
    expect(judgeRegression(rec({ recorded_at: "not a date" }), new Date()).passed).toBe(false);
  });

  it("skips the freshness check only when the corpus has never been embedded", () => {
    // null means there is no embedding to be stale against, not "assume fresh".
    expect(judgeRegression(rec({ recorded_at: "2020-01-01T00:00:00.000Z" }), null).passed).toBe(true);
  });

  it("staleness outranks good numbers — a perfect stale score still blocks", () => {
    const v = judgeRegression(
      rec({ recall_at_1: 1.0, mrr: 1.0, recorded_at: "2026-01-01T00:00:00.000Z" }),
      new Date("2026-08-17T09:41:00.000Z"),
    );
    expect(v.passed).toBe(false);
  });
});

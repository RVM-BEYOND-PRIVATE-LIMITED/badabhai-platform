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
  evalCoverage,
  judgeRegression,
  REGRESSION_BASELINE,
  reportPath,
  writeReport,
  type CandidateFacts,
  type Criterion,
  type PromotionReport,
} from "./promote-skills";
import type { CorpusFingerprint } from "./corpus-fingerprint";
import {
  countsAsEvalCoverage,
  isScoreable,
  loadEvalFixture,
  reviewStatusOf,
} from "./taxonomy-eval-fixture";
import { DEFAULT_FIXTURE } from "./taxonomy-retrieval-eval";
import { TAXONOMY_DATA_DIR } from "./taxonomy-corpus";
import { SKILL_CORPUS } from "@badabhai/taxonomy";

/**
 * The committed fixture and corpus, read once. Assertions about the CURRENT corpus have to
 * come FROM the corpus; the numbers that used to sit below as literals had already drifted.
 */
const FIXTURE = loadEvalFixture(DEFAULT_FIXTURE);
const CORPUS_SKILL_IDS: string[] = readFileSync(join(TAXONOMY_DATA_DIR, "skills.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0 && !l.startsWith("#"))
  .map((l) => JSON.parse(l).skill_id as string);
/** The wedge corpus — the skills production actually holds. A DISJOINT id space. */
const WEDGE_SKILL_IDS: string[] = SKILL_CORPUS.map((s) => s.skillId);

const coveredBy = (p: (c: (typeof FIXTURE)["cases"][number]) => boolean): Set<string> => {
  const out = new Set<string>();
  for (const c of FIXTURE.cases.filter(p)) {
    if (c.expected_skill_id !== null) out.add(c.expected_skill_id);
    for (const a of c.acceptable_skill_ids ?? []) out.add(a);
  }
  return out;
};
const COVERED_BY_ANY = coveredBy(() => true);
const COVERED_BY_REVIEWED = coveredBy((c) => reviewStatusOf(c) === "reviewed");

/** Two fingerprints differing ONLY in the skill_alias component — the election's signature. */
const FP_A: CorpusFingerprint = {
  skill_alias: "aaaa",
  skill: "bbbb",
  job_domain_skill: "cccc",
  job_domain: "dddd",
  job_domain_alias: "eeee",
  counts: {
    skill_alias_rows: 328,
    skill_alias_normalized: 328,
    skill_alias_searchable: 197,
    skill_alias_embedded: 295,
    skills_total: 146,
    skills_active: 33,
    job_domain_skill_active_edges: 238,
    job_domain_alias_rows: 9121,
    job_domain_alias_searchable: 0,
    job_domain_alias_embedded: 0,
  },
};
/** What the corpus looks like AFTER election: only is_searchable moved. */
const FP_B_SEARCHABLE: CorpusFingerprint = {
  ...FP_A,
  skill_alias: "aaaa-after-election",
  counts: { ...FP_A.counts, skill_alias_searchable: 326 },
};

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
  evidence_stale: false,
  reachable_aliases: 2,
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
      stale: false,
      drift: [],
    },
    sweep_record: "sweep.json",
    eval_record: "eval.json",
    // An APPLY report can only exist with a passing tripwire — a failing one refuses before
    // anything is written — so the default fixture is the only state APPLY can be in.
    match_vocabulary: {
      passed: true,
      counts: { MATCHED: 1, INTENTIONALLY_UNMATCHED: 0, MISSING_DECISION: 0, INVALID_TARGET: 0 },
      blocking: [],
    },
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
  // These used to be two literals — `covered = 61`, `total = 98` — under a comment calling
  // them "real numbers". They were real when written and then stopped being: E1 moves
  // coverage from 61 to 55 and neither literal would notice, because the test builds
  // synthetic verdicts and never reads the fixture it claims to describe. Derived now, so
  // the guard fails when the policy moves rather than when someone remembers to edit it.
  const total = CORPUS_SKILL_IDS.length;
  const covered = CORPUS_SKILL_IDS.filter((s) => COVERED_BY_REVIEWED.has(s)).length;

  it("blocks every corpus skill no REVIEWED case exercises", () => {
    const vs = [
      ...Array.from({ length: covered }, (_, i) => judge(ok({ skill_id: `c${i}` }))),
      ...Array.from({ length: total - covered }, (_, i) => judge(ok({ skill_id: `u${i}`, eval_covered: false }))),
    ];
    expect(vs.filter((v) => v.eligible)).toHaveLength(covered);
    expect(blockingHistogram(vs)).toEqual({ EVAL_COVERED: total - covered });
  });

  it("admits every candidate only when EVAL_COVERED is explicitly waived", () => {
    const w = new Set<Criterion>(["EVAL_COVERED"]);
    const vs = [
      ...Array.from({ length: covered }, (_, i) => judge(ok({ skill_id: `c${i}` }), w)),
      ...Array.from({ length: total - covered }, (_, i) => judge(ok({ skill_id: `u${i}`, eval_covered: false }), w)),
    ];
    expect(vs.filter((v) => v.eligible)).toHaveLength(total);
  });

  it("costs the corpus exactly 6 skills to read the spec strictly", () => {
    // The price of E1, against the same two sets the gate reads. Under `isScoreable` the
    // corpus had 61 covered skills; under `countsAsEvalCoverage` it has 55.
    const loose = CORPUS_SKILL_IDS.filter((s) => COVERED_BY_ANY.has(s)).length;
    expect(loose - covered).toBe(6);
    expect({ loose, strict: covered }).toEqual({ loose: 61, strict: 55 });
  });
});

// ===========================================================================
// E1 — EVAL_COVERED counts only REVIEWED cases (owner ruling 2026-08-20)
// ===========================================================================
describe("EVAL_COVERED reads countsAsEvalCoverage, not isScoreable", () => {
  it("separates the two questions, because they have different answers", () => {
    const mechanical = { provenance: "corpus_alias:skill_x/en" };
    const reviewed = { provenance: "hand_authored" };
    const pending = { provenance: "hand_authored", review_status: "pending_review" as const };

    // A mechanical case still SCORES — excluding it would silently move every published
    // metric — but it no longer UNLOCKS A PROMOTION. That gap is the entire change.
    expect(isScoreable(mechanical)).toBe(true);
    expect(countsAsEvalCoverage(mechanical)).toBe(false);

    expect(isScoreable(reviewed)).toBe(true);
    expect(countsAsEvalCoverage(reviewed)).toBe(true);

    expect(isScoreable(pending)).toBe(false);
    expect(countsAsEvalCoverage(pending)).toBe(false);
  });

  it("names the 6 skills the committed fixture covers ONLY mechanically", () => {
    // WHEN THIS FAILS, A TRAINER CASE LANDED (or a skill left the fixture). That is the
    // event the worksheet and the decision record both hang off, so failing loudly here is
    // the point — update `phase-9-trainer-worksheet.md` Part 3 and this list together.
    const mechanicalOnly = [...COVERED_BY_ANY].filter((s) => !COVERED_BY_REVIEWED.has(s)).sort();
    expect(mechanicalOnly).toEqual([
      "skill_earthing_and_bonding",
      "skill_order_picking_and_packing",
      "skill_pipe_support_and_clamping",
      "skill_punching_machine_operation",
      "skill_structural_fit_up_and_tacking",
      "skill_suspension_and_steering_repair",
    ]);
  });

  it("blocks zero live promotions, because none of the 6 is in production", () => {
    // The reason E1 is cheap RIGHT NOW: all six belong to the 98-skill Phase-3 growth
    // corpus, which is 0% seeded. Production holds the disjoint wedge corpus.
    const mechanicalOnly = [...COVERED_BY_ANY].filter((s) => !COVERED_BY_REVIEWED.has(s));
    expect(mechanicalOnly.length).toBeGreaterThan(0);
    for (const s of mechanicalOnly) {
      expect(CORPUS_SKILL_IDS).toContain(s); // they ARE growth-corpus skills...
      expect(WEDGE_SKILL_IDS).not.toContain(s); // ...and are NOT in the seeded wedge corpus
    }
  });

  it("computes the gate's answer over the COMMITTED fixture", () => {
    // The runner's own path, not a re-implementation of it: `evalCoverage` is the function
    // `main` calls. Mutation proof — swap `countsAsEvalCoverage` back to `isScoreable` in
    // `evalCoverage` and both halves of this fail (65 covered, 0 demoted).
    const { covered, demoted } = evalCoverage(FIXTURE);
    expect(covered.size).toBe(59);
    expect(demoted).toHaveLength(6);
    expect(demoted).toEqual([...demoted].sort()); // named in a stable order for the operator
    for (const s of demoted) expect(covered.has(s)).toBe(false);
  });

  it("still lets an operator through, on the record", () => {
    // E1 makes the gate stricter, not absolute. The waiver path predates this and was
    // unreachable while the gate was a no-op; it is the documented escape hatch.
    const v = judge(ok({ eval_covered: false }), new Set<Criterion>(["EVAL_COVERED"]));
    expect(v.eligible).toBe(true);
    expect(v.criteria.find((c) => c.criterion === "EVAL_COVERED")?.waived).toBe(true);
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

  it("accepts an evaluation whose corpus_fingerprint MATCHES the live corpus", () => {
    const v = judgeRegression(rec({ corpus_fingerprint: FP_A }), FP_A);
    expect(v.passed).toBe(true);
    expect(v.stale).toBe(false);
  });

  it("REFUSES an evaluation whose fingerprint describes a DIFFERENT corpus", () => {
    // Replaces the old timestamp check, which compared recorded_at against
    // max(embedded_at) and was therefore blind to text_norm, is_searchable, alias
    // add/remove, skill status, domain edges and domain aliases. Election — the next
    // authorized mutation — moves none of those timestamps.
    const v = judgeRegression(rec({ corpus_fingerprint: FP_A }), FP_B_SEARCHABLE);
    expect(v.passed).toBe(false);
    expect(v.stale).toBe(true);
    expect(v.drift).toEqual(["skill_alias"]);
    expect(v.detail).toMatch(/DIFFERENT corpus/);
  });

  it("REFUSES a record with no corpus_fingerprint — it cannot prove what it measured", () => {
    // EXP-P8-BASELINE and every earlier record are in this class. They stay valid as
    // EVIDENCE of the state they measured; they can never clear a freshness gate. Never
    // backfill a fingerprint — that fabricates the proof the field exists to provide.
    const v = judgeRegression(rec(), FP_A);
    expect(v.passed).toBe(false);
    expect(v.stale).toBe(true);
    expect(v.detail).toMatch(/no corpus_fingerprint/);
  });

  it("skips the freshness check only when no live fingerprint was supplied", () => {
    expect(judgeRegression(rec(), null).passed).toBe(true);
  });

  it("detects a change in EVERY fingerprint component, not just skill_alias", () => {
    // The old signal watched one column of one table. Each of these is a way to change what
    // retrieval returns while max(embedded_at) stands still.
    for (const [component, live] of [
      ["skill_alias", FP_B_SEARCHABLE],
      ["skill", { ...FP_A, skill: "changed" }],
      ["job_domain_skill", { ...FP_A, job_domain_skill: "changed" }],
      ["job_domain", { ...FP_A, job_domain: "changed" }],
      ["job_domain_alias", { ...FP_A, job_domain_alias: "changed" }],
    ] as const) {
      const v = judgeRegression(rec({ corpus_fingerprint: FP_A }), live);
      expect(v.passed, component).toBe(false);
      expect(v.drift, component).toEqual([component]);
    }
  });

  it("staleness outranks good numbers — a perfect stale score still blocks", () => {
    const v = judgeRegression(
      rec({ recall_at_1: 1.0, mrr: 1.0, corpus_fingerprint: FP_A }),
      FP_B_SEARCHABLE,
    );
    expect(v.passed).toBe(false);
    expect(v.stale).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// PR-1 — the loopholes found in the Phase 9 gate audit, each pinned by the failure it
// permitted. Every test here corresponds to a way promotion could previously have said
// "eligible" about a skill that was not.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("gate repair — a skill is not promotable merely because it has an embedding", () => {
  it("BLOCKS a fully-embedded skill whose aliases are all unreachable", () => {
    // THE INVARIANT THIS WHOLE WORKSTREAM EXISTS FOR. Every alias embedded, one model, no
    // mock sentinel — and not one of them retrievable under the semantics in force. Before
    // this, FULLY_EMBEDDED passed and the skill went live and unfindable.
    const v = judge(ok({ aliases: 4, unembedded_aliases: 0, reachable_aliases: 0 }));
    expect(v.eligible).toBe(false);
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toMatch(
      /live and unreachable/,
    );
  });

  it("passes when at least one alias is reachable", () => {
    expect(judge(ok({ aliases: 4, reachable_aliases: 1 })).eligible).toBe(true);
  });

  it("still reports the ORIGINAL embedding failures, not just reachability", () => {
    expect(judge(ok({ unembedded_aliases: 1, reachable_aliases: 1 })).blocking).toContain("FULLY_EMBEDDED");
    expect(judge(ok({ embedding_models: ["mock-embedding"], reachable_aliases: 1 })).blocking).toContain("FULLY_EMBEDDED");
    expect(judge(ok({ embedding_models: ["a", "b"], reachable_aliases: 1 })).blocking).toContain("FULLY_EMBEDDED");
    expect(judge(ok({ aliases: 0, reachable_aliases: 0 })).criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail)
      .toBe("no aliases at all");
  });
});

describe("gate repair — stale evidence is NOT waivable", () => {
  it("refuses to let --waive NO_REGRESSION absorb a STALE record", () => {
    // One flag used to grant two very different permissions: "I have reviewed this measured
    // regression and accept it" and "I accept a number that may not be about this corpus".
    // The first is a judgement a human can make. The second is not a judgement at all.
    const stale = ok({ no_regression: false, evidence_stale: true, regression_detail: "corpus moved" });
    const v = judge(stale, new Set<Criterion>(["NO_REGRESSION"]));
    expect(v.eligible).toBe(false);
    expect(v.blocking).toContain("NO_REGRESSION");
    expect(v.criteria.find((c) => c.criterion === "NO_REGRESSION")?.waived).toBe(false);
  });

  it("still lets --waive NO_REGRESSION absorb a FRESH, reviewed regression", () => {
    const fresh = ok({ no_regression: false, evidence_stale: false, regression_detail: "R@1 0.9912" });
    const v = judge(fresh, new Set<Criterion>(["NO_REGRESSION"]));
    expect(v.eligible).toBe(true);
    expect(v.criteria.find((c) => c.criterion === "NO_REGRESSION")?.waived).toBe(true);
  });

  it("does not make OTHER criteria unwaivable when evidence is stale", () => {
    const v = judge(
      ok({ eval_covered: false, evidence_stale: true }),
      new Set<Criterion>(["EVAL_COVERED"]),
    );
    expect(v.criteria.find((c) => c.criterion === "EVAL_COVERED")?.waived).toBe(true);
  });
});

describe("gate repair — the criteria list is closed and unchanged", () => {
  it("is exactly the seven canonical criteria, in order", () => {
    // No ABOVE_FLOOR, no NO_COLLISION. The reachability invariant is folded into
    // FULLY_EMBEDDED (already a composite) and freshness into NO_REGRESSION's staleness
    // flag, rather than growing the closed set.
    expect([...CRITERIA]).toEqual([
      "GATE_ACCEPTED",
      "IS_PROVISIONAL",
      "ACTIVE_EDGE",
      "FULLY_EMBEDDED",
      "EVAL_COVERED",
      "RESOLVABLE_ABOVE_FLOOR",
      "NO_REGRESSION",
    ]);
  });

  it("judges every criterion for every candidate, passing or not", () => {
    expect(judge(ok()).criteria.map((c) => c.criterion)).toEqual([...CRITERIA]);
  });
});

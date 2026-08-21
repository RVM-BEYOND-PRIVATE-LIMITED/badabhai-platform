/**
 * Metric arithmetic. These are the numbers a scaling decision gets made on, so every one of
 * them is pinned against a hand-computed expectation rather than a snapshot.
 *
 * The `competitor outranking` block is the Phase 6 correction and carries the heaviest
 * coverage: it replaced a measure that produced a 72.7% "leak" rate on a corpus where the
 * expected skill won every single one of those cases at rank 1. Both directions are pinned —
 * the case v1 wrongly failed AND the case v2 must still fail — because a correction that only
 * proves the false positive is gone cannot show it kept the true positive.
 */
import { describe, expect, it } from "vitest";

import {
  EVALUATOR_VERSION,
  evaluateCase,
  rankSkills,
  summarize,
  summarizeBy,
  type CaseOutcome,
  type RetrievedRow,
  type ScoredCase,
} from "./taxonomy-retrieval-metrics";

const row = (skill_id: string, score: number): RetrievedRow => ({ skill_id, score });

/** A CaseOutcome with everything defaulted, so a test states only the field it is about. */
const outcome = (o: Partial<CaseOutcome> = {}): CaseOutcome => ({
  rank: null,
  reciprocalRank: 0,
  outranked: [],
  assertsCompetitor: false,
  structuralViolations: [],
  empty: false,
  ranked: [],
  ...o,
});

describe("rankSkills", () => {
  it("orders by score descending", () => {
    expect(rankSkills([row("b", 0.4), row("a", 0.9), row("c", 0.6)]).map((r) => r.skill_id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("DEDUPES a skill that matched through several aliases, keeping its best score", () => {
    // Without this, one skill's three aliases occupy the whole top-3 and Recall@3 measures
    // alias count rather than retrieval.
    const ranked = rankSkills([row("a", 0.5), row("a", 0.95), row("a", 0.2), row("b", 0.7)]);
    expect(ranked).toEqual([
      { skill_id: "a", score: 0.95 },
      { skill_id: "b", score: 0.7 },
    ]);
  });

  it("breaks ties DETERMINISTICALLY on skill_id, whatever order the rows arrive in", () => {
    const forward = rankSkills([row("b", 0.5), row("a", 0.5), row("c", 0.5)]).map((r) => r.skill_id);
    const reverse = rankSkills([row("c", 0.5), row("a", 0.5), row("b", 0.5)]).map((r) => r.skill_id);
    expect(forward).toEqual(["a", "b", "c"]);
    expect(reverse).toEqual(forward);
  });

  it("returns nothing for no rows", () => {
    expect(rankSkills([])).toEqual([]);
  });

  it("breaks ties on CODEPOINT order, not locale collation", () => {
    // localeCompare ignores punctuation, so "skill_co2_welding" vs "skill_co2welding"
    // can order differently across Node/ICU builds — a metric that moves between machines.
    const ranked = rankSkills([row("skill_co2welding", 0.5), row("skill_co2_welding", 0.5)]);
    expect(ranked.map((r) => r.skill_id)).toEqual(["skill_co2_welding", "skill_co2welding"]);
    expect("skill_co2_welding" < "skill_co2welding").toBe(true);
  });

  it("COERCES a string score, as production does", () => {
    // If a driver ever returns numerics as strings, `>` would be a lexicographic compare
    // when picking a skill's best alias while the sort stayed numeric: "0.9" > "0.85" is
    // true lexicographically AND numerically, but "0.9" > "0.1234" flips.
    const rows = [
      { skill_id: "a", score: "0.1234" as unknown as number },
      { skill_id: "a", score: "0.9" as unknown as number },
    ];
    expect(rankSkills(rows)).toEqual([{ skill_id: "a", score: 0.9 }]);
  });
});

describe("evaluateCase — ranking", () => {
  const target = { expected_skill_id: "want" };

  it("rank 1 -> reciprocal rank 1", () => {
    const o = evaluateCase(target, [row("want", 0.9), row("other", 0.5)], 5);
    expect(o.rank).toBe(1);
    expect(o.reciprocalRank).toBe(1);
  });

  it("rank 3 -> reciprocal rank 1/3", () => {
    const o = evaluateCase(target, [row("a", 0.9), row("b", 0.8), row("want", 0.7)], 5);
    expect(o.rank).toBe(3);
    expect(o.reciprocalRank).toBeCloseTo(1 / 3, 10);
  });

  it("absent from top-k -> rank null, reciprocal rank 0", () => {
    const o = evaluateCase(target, [row("a", 0.9), row("b", 0.8)], 5);
    expect(o.rank).toBeNull();
    expect(o.reciprocalRank).toBe(0);
  });

  it("TRUNCATES at k before judging, so a hit outside k does not count", () => {
    const rows = [row("a", 0.9), row("b", 0.8), row("c", 0.7), row("want", 0.6)];
    expect(evaluateCase(target, rows, 5).rank).toBe(4);
    expect(evaluateCase(target, rows, 3).rank).toBeNull();
  });

  it("accepts a reviewed ALTERNATIVE as correct, at its own rank", () => {
    const o = evaluateCase(
      { expected_skill_id: "want", acceptable_skill_ids: ["also_fine"] },
      [row("a", 0.9), row("also_fine", 0.8)],
      5,
    );
    expect(o.rank).toBe(2);
  });

  it("takes the FIRST correct id when both the expected and an alternative are present", () => {
    const o = evaluateCase(
      { expected_skill_id: "want", acceptable_skill_ids: ["also_fine"] },
      [row("also_fine", 0.9), row("want", 0.8)],
      5,
    );
    expect(o.rank).toBe(1);
  });

  it("flags an empty result", () => {
    const o = evaluateCase(target, [], 5);
    expect(o.empty).toBe(true);
    expect(o.rank).toBeNull();
  });

  it("rejects a nonsense k rather than silently ranking everything", () => {
    expect(() => evaluateCase(target, [], 0)).toThrow(/positive integer/);
    expect(() => evaluateCase(target, [], 1.5)).toThrow(/positive integer/);
  });
});

// ===========================================================================
// The Phase 6 correction. Both directions, and the shape that motivated it.
// ===========================================================================
describe("evaluateCase — SEMANTIC: a competitor must not OUTRANK the expected skill", () => {
  const target = { expected_skill_id: "want", must_not_return_skill_ids: ["rival"] };

  it("does NOT flag a competitor that merely APPEARS below the expected skill", () => {
    // THE CORRECTION. This exact shape produced 8 of 8 "leaks" in the Phase 5 baseline: the
    // expected skill at rank 1, the forbidden sibling present but beaten. v1 called it a
    // leak because it asked "is it in the top k", which in a 6-11 skill domain at k=5 is
    // nearly always yes and is governed by pool size, not by ranking.
    const o = evaluateCase(target, [row("want", 0.86), row("rival", 0.67)], 5);
    expect(o.rank).toBe(1);
    expect(o.outranked).toEqual([]);
    expect(o.ranked).toContain("rival"); // it WAS returned — presence is not the question
  });

  it("DOES flag a competitor that placed above the expected skill", () => {
    // The other direction. A correction that only proves the false positive is gone has not
    // shown it still catches the real thing.
    const o = evaluateCase(target, [row("rival", 0.88), row("want", 0.72)], 5);
    expect(o.rank).toBe(2);
    expect(o.outranked).toEqual(["rival"]);
  });

  it("treats an ABSENT expected skill as outranked by every competitor present", () => {
    // The expected skill's position is effectively infinite here. Comparing a competitor's
    // index against `rank === null` would score this clean, which is the worst outcome the
    // metric could produce: total retrieval failure reported as no competitor problem.
    const o = evaluateCase(target, [row("rival", 0.9), row("noise", 0.4)], 5);
    expect(o.rank).toBeNull();
    expect(o.outranked).toEqual(["rival"]);
  });

  it("is clean when the expected skill is absent and so is the competitor", () => {
    const o = evaluateCase(target, [row("noise", 0.4)], 5);
    expect(o.rank).toBeNull();
    expect(o.outranked).toEqual([]);
  });

  it("names every competitor above the bar, in rank order", () => {
    const o = evaluateCase(
      { expected_skill_id: "want", must_not_return_skill_ids: ["r1", "r2"] },
      [row("r2", 0.9), row("r1", 0.8), row("want", 0.7)],
      5,
    );
    expect(o.outranked).toEqual(["r2", "r1"]);
  });

  it("judges position INSIDE k — a competitor truncated away cannot outrank", () => {
    const rows = [row("want", 0.9), row("rival", 0.8)];
    expect(evaluateCase(target, rows, 1).ranked).toEqual(["want"]);
    expect(evaluateCase(target, rows, 1).outranked).toEqual([]);
  });

  it("counts a competitor that beat an ACCEPTABLE alternative, not just the expected id", () => {
    // Once an alternative is reviewed as correct, beating it is the same failure as beating
    // the expected id — the bar is the first CORRECT skill, whichever it is.
    const o = evaluateCase(
      { expected_skill_id: "want", acceptable_skill_ids: ["also_fine"], must_not_return_skill_ids: ["rival"] },
      [row("rival", 0.9), row("also_fine", 0.8)],
      5,
    );
    expect(o.rank).toBe(2);
    expect(o.outranked).toEqual(["rival"]);
  });

  it("records that the case ASSERTED a competitor, so the rate has an honest denominator", () => {
    expect(evaluateCase(target, [row("want", 0.9)], 5).assertsCompetitor).toBe(true);
    expect(evaluateCase({ expected_skill_id: "want" }, [row("want", 0.9)], 5).assertsCompetitor).toBe(false);
  });

  it("does not count the expected skill as outranking ITSELF", () => {
    // Pins the boundary of the slice. A case that lists the same id as both expected and
    // forbidden is rejected by validateEvalFixture, so this input cannot reach a real run —
    // which is exactly why it is worth a test: it proves the metric's correctness does not
    // quietly depend on the validator having run first. The bar is everything STRICTLY
    // above the first correct skill; including the skill's own position would let an
    // invalid fixture report a query as failing against itself.
    const o = evaluateCase(
      { expected_skill_id: "want", must_not_return_skill_ids: ["want"] },
      [row("want", 0.9), row("other", 0.5)],
      5,
    );
    expect(o.rank).toBe(1);
    expect(o.outranked).toEqual([]);
  });

  it("never produces a STRUCTURAL violation on a positive case", () => {
    // A positive case's forbidden ids are in-scope competitors by fixture rule. Their
    // presence is legitimate competition, never a scoping bug, and folding the two together
    // is what made the old single number unreadable.
    const o = evaluateCase(target, [row("rival", 0.9), row("want", 0.8)], 5);
    expect(o.structuralViolations).toEqual([]);
  });
});

describe("evaluateCase — STRUCTURAL: a negative case guards the scoping", () => {
  const negative = { expected_skill_id: null, must_not_return_skill_ids: ["out_of_scope"] };

  it("a NEGATIVE case has no rank and contributes 0 reciprocal rank", () => {
    // Not rank 0 and not rank 1: "correctly returned nothing" and "found it first" are
    // opposite outcomes and must not average together.
    const o = evaluateCase(negative, [row("x", 0.4)], 5);
    expect(o.rank).toBeNull();
    expect(o.reciprocalRank).toBe(0);
    expect(o.structuralViolations).toEqual([]);
  });

  it("names an out-of-scope id that came back at all", () => {
    // Presence IS the right question here: the job_domain_skill INNER JOIN should have made
    // this unreachable, so a hit means the scoping regressed.
    const o = evaluateCase(negative, [row("out_of_scope", 0.9)], 5);
    expect(o.structuralViolations).toEqual(["out_of_scope"]);
  });

  it("judges presence INSIDE k", () => {
    const rows = [row("a", 0.9), row("out_of_scope", 0.5)];
    expect(evaluateCase(negative, rows, 1).structuralViolations).toEqual([]);
    expect(evaluateCase(negative, rows, 2).structuralViolations).toEqual(["out_of_scope"]);
  });

  it("never produces an OUTRANK finding on a negative case", () => {
    // There is no expected skill to outrank. Reporting one would put a structural scoping
    // failure into the semantic column and let it be quoted as a model result.
    const o = evaluateCase(negative, [row("out_of_scope", 0.9)], 5);
    expect(o.outranked).toEqual([]);
    expect(o.assertsCompetitor).toBe(false);
  });
});

describe("summarize", () => {
  const hit = (rank: number | null): ScoredCase => ({
    positive: true,
    outcome: outcome({ rank, reciprocalRank: rank === null ? 0 : 1 / rank }),
  });

  it("computes Recall@k and MRR over positive cases", () => {
    // ranks 1, 2, 5, miss -> R@1 .25, R@3 .5, R@5 .75, MRR (1 + .5 + .2 + 0)/4 = .425
    const s = summarize([hit(1), hit(2), hit(5), hit(null)]);
    expect(s.recall_at_1).toBe(0.25);
    expect(s.recall_at_3).toBe(0.5);
    expect(s.recall_at_5).toBe(0.75);
    expect(s.mrr).toBe(0.425);
    expect(s.scored).toBe(4);
  });

  it("returns NULL, not 0, when there is nothing to score", () => {
    // A pure-negative group reading "Recall@1 = 0" looks like total failure when it is
    // actually not applicable — the exact misreading that hides a real result.
    const s = summarize([{ positive: false, outcome: outcome() }]);
    expect(s.recall_at_1).toBeNull();
    expect(s.mrr).toBeNull();
    expect(s.no_result_rate).toBeNull();
    expect(s.structural_isolation_cases).toBe(1);
    expect(s.structural_isolation_violations).toBe(0);
  });

  it("divides MRR by the POSITIVE count, not the total case count", () => {
    // One positive at rank 1 alongside one negative is MRR 1.0, not 0.5. Using
    // cases.length as the denominator silently deflates every mixed group.
    const s = summarize([hit(1), { positive: false, outcome: outcome() }]);
    expect(s.mrr).toBe(1);
    expect(s.scored).toBe(1);
    expect(s.queries).toBe(2);
  });

  it("reports the no-result rate over positive cases only", () => {
    const empty: ScoredCase = { positive: true, outcome: outcome({ empty: true }) };
    expect(summarize([hit(1), empty]).no_result_rate).toBe(0.5);
  });

  it("excludes empty NEGATIVE cases from the no-result rate", () => {
    // A negative case returning nothing is the CORRECT outcome. Counting it as a
    // no-result would make perfect domain isolation look like broken retrieval.
    const emptyNegative: ScoredCase = { positive: false, outcome: outcome({ empty: true }) };
    expect(summarize([hit(1), emptyNegative]).no_result_rate).toBe(0);
  });

  it("reports Recall@N as NULL when the run only fetched k < N", () => {
    // Recall@5 from a k=1 run is Recall@1 wearing a bigger label. Reporting a number that
    // is right about the wrong question is worse than reporting none.
    const s = summarize([hit(1)], 1);
    expect(s.recall_at_1).toBe(1);
    expect(s.recall_at_3).toBeNull();
    expect(s.recall_at_5).toBeNull();
  });

  it("an entirely empty group does not divide by zero", () => {
    const s = summarize([]);
    expect(s.queries).toBe(0);
    expect(s.recall_at_1).toBeNull();
    expect(s.competitor_outranking_rate).toBeNull();
    expect(s.structural_isolation_cases).toBe(0);
  });
});

describe("summarize — the two forbidden-id measures stay apart", () => {
  const asserting = (outranked: string[]): ScoredCase => ({
    positive: true,
    outcome: outcome({ rank: 1, reciprocalRank: 1, assertsCompetitor: true, outranked }),
  });
  const silent: ScoredCase = { positive: true, outcome: outcome({ rank: 1, reciprocalRank: 1 }) };

  it("divides outranking by ASSERTING cases, not by every positive case", () => {
    // The denominator is the whole point. 1 outranked out of 2 asserting cases is 50%;
    // dividing the same 1 by 4 positives reads 25% and nothing about the model changed.
    const s = summarize([asserting(["rival"]), asserting([]), silent, silent]);
    expect(s.competitor_asserting_cases).toBe(2);
    expect(s.competitor_outranked_cases).toBe(1);
    expect(s.competitor_outranking_rate).toBe(0.5);
    expect(s.scored).toBe(4);
  });

  it("reports NULL — not 0 — when the group asserted no competitor at all", () => {
    // 0% would read as "measured and clean" for a group that measured nothing.
    const s = summarize([silent, silent]);
    expect(s.competitor_asserting_cases).toBe(0);
    expect(s.competitor_outranking_rate).toBeNull();
  });

  it("keeps structural violations OUT of the outranking rate", () => {
    const structural: ScoredCase = {
      positive: false,
      outcome: outcome({ structuralViolations: ["out_of_scope"] }),
    };
    const s = summarize([asserting([]), structural]);
    expect(s.competitor_outranking_rate).toBe(0); // one asserting case, clean
    expect(s.structural_isolation_cases).toBe(1);
    expect(s.structural_isolation_violations).toBe(1);
  });

  it("keeps outranking OUT of the structural counts", () => {
    const s = summarize([asserting(["rival"])]);
    expect(s.competitor_outranked_cases).toBe(1);
    expect(s.structural_isolation_cases).toBe(0);
    expect(s.structural_isolation_violations).toBe(0);
  });

  it("reproduces the Phase 5 lexical_ambiguity group under BOTH readings", () => {
    // 11 asserting cases; in 8 of them the forbidden sibling was returned but BEATEN.
    // v1 (membership) reported 8/11 = 72.7% and it was quoted as leakage.
    // v2 (position) reports 0/11, because the expected skill won all 11.
    const group = [
      ...Array.from({ length: 8 }, () => asserting([])), // returned-but-beaten
      ...Array.from({ length: 3 }, () => asserting([])), // competitor absent entirely
    ];
    const s = summarize(group);
    expect(s.competitor_asserting_cases).toBe(11);
    expect(s.competitor_outranked_cases).toBe(0);
    expect(s.competitor_outranking_rate).toBe(0);
    expect(s.recall_at_1).toBe(1);
  });
});

describe("summarizeBy", () => {
  const c = (group: string, rank: number | null): ScoredCase & { group: string } => ({
    group,
    positive: true,
    outcome: outcome({ rank, reciprocalRank: rank === null ? 0 : 1 / rank }),
  });

  it("a strong group cannot hide a broken one", () => {
    // This is the whole reason per-group reporting exists: overall reads 0.75 while
    // `weak` is at 0.0, and only the breakdown shows it.
    const { overall, groups } = summarizeBy([c("strong", 1), c("strong", 1), c("strong", 1), c("weak", null)]);
    expect(overall.recall_at_1).toBe(0.75);
    expect(groups.strong?.recall_at_1).toBe(1);
    expect(groups.weak?.recall_at_1).toBe(0);
    expect(groups.weak?.queries).toBe(1);
  });

  it("groups are sorted so two runs are diffable", () => {
    const { groups } = summarizeBy([c("z", 1), c("a", 1)]);
    expect(Object.keys(groups)).toEqual(["a", "z"]);
  });
});

describe("EVALUATOR_VERSION", () => {
  it("is 2 — the Phase 6 semantics", () => {
    // Pinned deliberately. Changing what a metric MEANS without changing this constant is
    // how a report ends up diffing two different questions and calling it a regression.
    expect(EVALUATOR_VERSION).toBe(2);
  });
});

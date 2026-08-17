/**
 * Metric arithmetic. These are the numbers a scaling decision gets made on, so every one of
 * them is pinned against a hand-computed expectation rather than a snapshot.
 */
import { describe, expect, it } from "vitest";

import {
  evaluateCase,
  rankSkills,
  summarize,
  summarizeBy,
  type RetrievedRow,
  type ScoredCase,
} from "./taxonomy-retrieval-metrics";

const row = (skill_id: string, score: number): RetrievedRow => ({ skill_id, score });

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

describe("evaluateCase", () => {
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

  it("reports leakage only for forbidden ids INSIDE k", () => {
    const rows = [row("want", 0.9), row("bad", 0.8), row("alsobad", 0.1)];
    expect(evaluateCase({ ...target, must_not_return_skill_ids: ["bad", "alsobad"] }, rows, 2).leaked).toEqual([
      "bad",
    ]);
    expect(evaluateCase({ ...target, must_not_return_skill_ids: ["bad", "alsobad"] }, rows, 3).leaked).toEqual([
      "bad",
      "alsobad",
    ]);
  });

  it("a NEGATIVE case has no rank and contributes 0 reciprocal rank", () => {
    // Not rank 0 and not rank 1: "correctly returned nothing" and "found it first" are
    // opposite outcomes and must not average together.
    const o = evaluateCase({ expected_skill_id: null, must_not_return_skill_ids: ["bad"] }, [row("x", 0.4)], 5);
    expect(o.rank).toBeNull();
    expect(o.reciprocalRank).toBe(0);
    expect(o.leaked).toEqual([]);
  });

  it("a NEGATIVE case that leaks names the leak", () => {
    const o = evaluateCase({ expected_skill_id: null, must_not_return_skill_ids: ["bad"] }, [row("bad", 0.9)], 5);
    expect(o.leaked).toEqual(["bad"]);
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

describe("summarize", () => {
  const hit = (rank: number | null): ScoredCase => ({
    positive: true,
    outcome: {
      rank,
      reciprocalRank: rank === null ? 0 : 1 / rank,
      leaked: [],
      empty: false,
      ranked: [],
    },
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
    const s = summarize([
      { positive: false, outcome: { rank: null, reciprocalRank: 0, leaked: [], empty: false, ranked: [] } },
    ]);
    expect(s.recall_at_1).toBeNull();
    expect(s.mrr).toBeNull();
    expect(s.no_result_rate).toBeNull();
    expect(s.negative_cases).toBe(1);
    expect(s.negative_clean).toBe(1);
  });

  it("counts leakage across positive AND negative cases", () => {
    const leaky: ScoredCase = {
      positive: false,
      outcome: { rank: null, reciprocalRank: 0, leaked: ["bad"], empty: false, ranked: [] },
    };
    const s = summarize([hit(1), leaky]);
    expect(s.cross_domain_leakage_rate).toBe(0.5);
    expect(s.negative_cases).toBe(1);
    expect(s.negative_clean).toBe(0);
  });

  it("counts a POSITIVE case that leaks — leakage is not a negatives-only metric", () => {
    // A query that finds the right skill AND drags a forbidden one in with it is still a
    // leak. Scoping the numerator to negatives would report 0 here.
    const leakyPositive: ScoredCase = {
      positive: true,
      outcome: { rank: 1, reciprocalRank: 1, leaked: ["bad"], empty: false, ranked: [] },
    };
    const s = summarize([leakyPositive, hit(1)]);
    expect(s.cross_domain_leakage_rate).toBe(0.5);
  });

  it("divides MRR by the POSITIVE count, not the total case count", () => {
    // One positive at rank 1 alongside one negative is MRR 1.0, not 0.5. Using
    // cases.length as the denominator silently deflates every mixed group.
    const negative: ScoredCase = {
      positive: false,
      outcome: { rank: null, reciprocalRank: 0, leaked: [], empty: false, ranked: [] },
    };
    const s = summarize([hit(1), negative]);
    expect(s.mrr).toBe(1);
    expect(s.scored).toBe(1);
    expect(s.queries).toBe(2);
  });

  it("reports the no-result rate over positive cases only", () => {
    const empty: ScoredCase = {
      positive: true,
      outcome: { rank: null, reciprocalRank: 0, leaked: [], empty: true, ranked: [] },
    };
    expect(summarize([hit(1), empty]).no_result_rate).toBe(0.5);
  });

  it("excludes empty NEGATIVE cases from the no-result rate", () => {
    // A negative case returning nothing is the CORRECT outcome. Counting it as a
    // no-result would make perfect domain isolation look like broken retrieval.
    const emptyNegative: ScoredCase = {
      positive: false,
      outcome: { rank: null, reciprocalRank: 0, leaked: [], empty: true, ranked: [] },
    };
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
    expect(s.cross_domain_leakage_rate).toBe(0);
  });
});

describe("summarizeBy", () => {
  const c = (group: string, rank: number | null): ScoredCase & { group: string } => ({
    group,
    positive: true,
    outcome: { rank, reciprocalRank: rank === null ? 0 : 1 / rank, leaked: [], empty: false, ranked: [] },
  });

  it("a strong group cannot hide a broken one", () => {
    // This is the whole reason per-group reporting exists: overall reads 0.75 while
    // `weak` is at 0.0, and only the breakdown shows it.
    const { overall, groups } = summarizeBy([
      c("strong", 1),
      c("strong", 1),
      c("strong", 1),
      c("weak", null),
    ]);
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

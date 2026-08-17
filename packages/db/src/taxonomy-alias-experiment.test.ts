import { describe, expect, it } from "vitest";

import { CANONICALIZATION_FLOOR } from "./promote-skills";
import {
  assertExactSimulationHolds,
  canonicalLabelCandidates,
  classifyCase,
  cosine,
  normalizeAliasText,
  recommendation,
  summarizeSimulation,
  topSkill,
  type AliasScore,
  type CaseSimulation,
} from "./taxonomy-alias-experiment";

const meta = {
  case_id: "T-01",
  category: "paraphrase_latin",
  job_domain_id: "jd_test",
  expected_skill_id: "skill_want",
};
const accepted = new Set(["skill_want"]);
const WINDOW = 40;

describe("normalizeAliasText", () => {
  it("folds case and punctuation so a label matches an equivalent alias", () => {
    expect(normalizeAliasText("Coolant management")).toBe(normalizeAliasText("coolant  management"));
    expect(normalizeAliasText("GD&T reading")).toBe("gd t reading");
  });

  it("PRESERVES Devanagari", () => {
    // Stripping it would fold every Hindi alias to "", and every Hindi-labelled skill would
    // then look like it already carried its own label — silently emptying the candidate set
    // for exactly the workers this platform exists to serve.
    expect(normalizeAliasText("कूलेंट भरना")).toBe("कूलेंट भरना");
    expect(normalizeAliasText("कूलेंट भरना")).not.toBe("");
  });
});

describe("canonicalLabelCandidates", () => {
  it("proposes the label when it is absent from the alias set", () => {
    const c = canonicalLabelCandidates([
      { skill_id: "a", label_en: "Coolant management", aliases: ["coolant top up"] },
    ]);
    expect(c.get("a")).toBe("Coolant management");
  });

  it("proposes nothing when the label is already an alias, whatever its casing", () => {
    const c = canonicalLabelCandidates([
      { skill_id: "a", label_en: "Coolant management", aliases: ["COOLANT MANAGEMENT"] },
    ]);
    expect(c.size).toBe(0);
  });

  it("skips skills with no usable label rather than proposing an empty alias", () => {
    const c = canonicalLabelCandidates([
      { skill_id: "a", label_en: null, aliases: [] },
      { skill_id: "b", label_en: "   ", aliases: [] },
    ]);
    expect(c.size).toBe(0);
  });

  it("proposes a label for a skill with no aliases at all", () => {
    const c = canonicalLabelCandidates([{ skill_id: "a", label_en: "Boring", aliases: [] }]);
    expect(c.get("a")).toBe("Boring");
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    // A NaN score sorts unpredictably and would silently drop a skill out of the ranking
    // instead of placing it last.
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe("topSkill — the window is applied BEFORE collapsing to skills", () => {
  it("returns the best-scoring skill", () => {
    const rows: AliasScore[] = [
      { skill_id: "a", score: 0.6 },
      { skill_id: "b", score: 0.9 },
    ];
    expect(topSkill(rows, WINDOW)).toEqual({ skill_id: "b", score: 0.9 });
  });

  it("returns the same winner at any window size, because sorting precedes slicing", () => {
    // Deliberately pinning the INERTNESS of the window here rather than pretending it guards
    // the winner. Slicing a score-sorted list can only discard rows that already lost, so no
    // window can change the top-1 — mutation A06 deletes the slice and survives, and that is
    // correct rather than a coverage gap. Truncation is a visibility property and is asserted
    // against `after_rank` in the summary tests below.
    const rows: AliasScore[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ skill_id: `filler${i}`, score: 0.9 - i * 0.01 })),
      { skill_id: "buried", score: 0.5 },
    ];
    for (const w of [1, 2, 3, 4, 40]) expect(topSkill(rows, w).skill_id).toBe("filler0");
  });

  it("reports a null skill and score 0 for an empty result rather than throwing", () => {
    expect(topSkill([], WINDOW)).toEqual({ skill_id: null, score: 0 });
  });
});

describe("classifyCase — rank", () => {
  const before: AliasScore[] = [
    { skill_id: "skill_rival", score: 0.70 },
    { skill_id: "skill_want", score: 0.66 },
  ];

  it("FIXED when the candidate takes the top spot for the expected skill", () => {
    const after = [...before, { skill_id: "skill_want", score: 0.78 }];
    const r = classifyCase(meta, accepted, before, after, WINDOW);
    expect(r.verdict).toBe("fixed");
    expect(r.after_skill_id).toBe("skill_want");
  });

  it("BROKEN when a candidate for the WRONG skill outranks a previously correct answer", () => {
    // The failure mode a fix-only simulation cannot see: the change works for the target case
    // and quietly steals another. If this ever stops being detected, the harness recommends
    // regressions.
    const wasRight: AliasScore[] = [{ skill_id: "skill_want", score: 0.80 }];
    const after = [...wasRight, { skill_id: "skill_rival", score: 0.91 }];
    expect(classifyCase(meta, accepted, wasRight, after, WINDOW).verdict).toBe("broken");
  });

  it("STILL_WRONG when the candidate helps but not enough", () => {
    const after = [...before, { skill_id: "skill_want", score: 0.69 }];
    expect(classifyCase(meta, accepted, before, after, WINDOW).verdict).toBe("still_wrong");
  });

  it("UNCHANGED when the case was already correct and stays correct", () => {
    const wasRight: AliasScore[] = [{ skill_id: "skill_want", score: 0.9 }];
    expect(classifyCase(meta, accepted, wasRight, wasRight, WINDOW).verdict).toBe("unchanged");
  });

  it("honours acceptable_skill_ids — an accepted answer is not a miss", () => {
    // AL-01 resolves to skill_forklift_operation, which the fixture explicitly accepts.
    // Judging on expected_skill_id alone would report a pre-existing miss the evaluator never
    // counted, and then credit any change that moved it with a fix that was never broken.
    const acc = new Set(["skill_want", "skill_also_fine"]);
    const rows: AliasScore[] = [{ skill_id: "skill_also_fine", score: 0.88 }];
    expect(classifyCase(meta, acc, rows, rows, WINDOW).verdict).toBe("unchanged");
  });
});

describe("classifyCase — floor", () => {
  const at = (score: number): AliasScore[] => [{ skill_id: "skill_want", score }];

  it("LIFTED when a correct answer crosses the floor", () => {
    const r = classifyCase(meta, accepted, at(0.69), [...at(0.69), ...at(0.78)], WINDOW);
    expect(r.floor).toBe("lifted");
  });

  it("DROPPED when a correct answer falls below the floor", () => {
    const r = classifyCase(meta, accepted, at(0.80), at(0.70), WINDOW);
    expect(r.floor).toBe("dropped");
  });

  it("treats the floor as inclusive, matching canonicalization itself", () => {
    // Canonicalization assigns at >= the floor. An exclusive test here would report a case as
    // still unresolvable when production would in fact resolve it.
    const r = classifyCase(meta, accepted, at(0.70), at(CANONICALIZATION_FLOOR), WINDOW);
    expect(r.floor).toBe("lifted");
  });

  it("reports no floor movement for a case that is wrong either way", () => {
    const wrong: AliasScore[] = [{ skill_id: "skill_rival", score: 0.9 }];
    expect(classifyCase(meta, accepted, wrong, wrong, WINDOW).floor).toBe("none");
  });

  it("does not report a floor lift on a case that was WRONG before", () => {
    // Rank and floor are separate questions and a fixed case is already counted once. Letting
    // it also count as "lifted" would double-count a single improvement.
    const r = classifyCase(meta, accepted, [{ skill_id: "skill_rival", score: 0.7 }], at(0.9), WINDOW);
    expect(r.verdict).toBe("fixed");
    expect(r.floor).toBe("none");
  });
});

describe("summarizeSimulation", () => {
  const row = (o: Partial<CaseSimulation>): CaseSimulation => ({
    case_id: "x",
    category: "c",
    job_domain_id: "d",
    expected_skill_id: "s",
    verdict: "unchanged",
    before_skill_id: "s",
    before_score: 0.9,
    after_skill_id: "s",
    after_score: 0.9,
    floor: "none",
    before_rank: 1,
    after_rank: 1,
    ...o,
  });

  it("counts recall before and after from the verdicts", () => {
    const s = summarizeSimulation(
      [row({ verdict: "unchanged" }), row({ verdict: "fixed" }), row({ verdict: "still_wrong" })],
      WINDOW,
    );
    expect(s.recall_at_1_before).toBeCloseTo(1 / 3, 10);
    expect(s.recall_at_1_after).toBeCloseTo(2 / 3, 10);
  });

  it("counts a case pushed outside the window as truncated", () => {
    const s = summarizeSimulation([row({ after_rank: WINDOW + 1 }), row({ after_rank: 0 })], WINDOW);
    expect(s.truncated).toBe(2);
  });

  it("does not divide by zero on an empty run", () => {
    expect(summarizeSimulation([], WINDOW).recall_at_1_after).toBe(0);
  });
});

describe("recommendation — a change must improve something AND cost nothing", () => {
  const base = {
    cases: 100,
    fixed: 1,
    broken: 0,
    still_wrong: 0,
    unchanged: 99,
    lifted_over_floor: 7,
    dropped_under_floor: 0,
    truncated: 0,
    recall_at_1_before: 0.99,
    recall_at_1_after: 1,
  };

  it("ACTs when it fixes cases and breaks nothing", () => {
    expect(recommendation(base).act).toBe(true);
  });

  it("REFUSES on any regression, however many cases it also fixes", () => {
    // A change with a good net score is still a change that put a wrong skill on someone's
    // profile. The gate is not net-positive, it is no-regression.
    expect(recommendation({ ...base, fixed: 50, broken: 1 }).act).toBe(false);
  });

  it("REFUSES when a correct answer drops below the floor", () => {
    expect(recommendation({ ...base, dropped_under_floor: 1 }).act).toBe(false);
  });

  it("REFUSES when added density truncates a case out of the window", () => {
    expect(recommendation({ ...base, truncated: 1 }).act).toBe(false);
  });

  it("does not recommend acting on a change with no effect", () => {
    expect(recommendation({ ...base, fixed: 0, lifted_over_floor: 0 }).act).toBe(false);
  });

  it("ACTs on a floor-only improvement, even with nothing fixed", () => {
    // Lifting a correct-but-unassignable case over the floor is a real gain: it is the
    // difference between a skill that is right and a skill that reaches a worker's profile.
    expect(recommendation({ ...base, fixed: 0, lifted_over_floor: 3 }).act).toBe(true);
  });
});

describe("assertExactSimulationHolds", () => {
  it("passes when a re-embedded alias reproduces its stored vector", () => {
    expect(() => assertExactSimulationHolds(1)).not.toThrow();
    expect(() => assertExactSimulationHolds(0.9999)).not.toThrow();
  });

  it("REFUSES once query and document vectors diverge", () => {
    // The moment a task_type or a model change breaks the identity, every simulated score
    // becomes a guess — and a guess must not be allowed to authorise a corpus write.
    expect(() => assertExactSimulationHolds(0.97)).toThrow(/no longer exact/);
  });
});

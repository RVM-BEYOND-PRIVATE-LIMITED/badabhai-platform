/**
 * §5a-2 — the margin arithmetic, and the tripwire on what it measured.
 *
 * The point of the file is to make three claims un-forgettable: no separation threshold orders
 * the right answers apart from the wrong ones; the value that would work costs more than the
 * problem; and a lexical rule misses the pair that motivated the question. All three are
 * arithmetic, so none of them is a preference — and none of them is a decision either. A test
 * below asserts that no policy has been implemented anywhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { missingProvenance } from "./evidence-provenance";
import {
  classifyMargin,
  lexicalCoverage,
  separatingSeparation,
  sharesToken,
  sweepSeparation,
  tokens,
  type MarginObservation,
} from "./sibling-margin";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");

const o = (own: number | null, other: number | null, extra: Partial<MarginObservation> = {}): MarginObservation => ({
  phrase: "p",
  domain: "d",
  ownSkill: "skill_own",
  ownScore: own,
  otherSkill: other === null ? null : "skill_other",
  otherScore: other,
  otherVia: other === null ? null : "v",
  ...extra,
});

describe("classifyMargin", () => {
  it("separation 0 IS today's policy — the sweep needs no second code path for the baseline", () => {
    expect(classifyMargin(o(0.9, 0.8), 0.75, 0)).toBe("CORRECT");
    expect(classifyMargin(o(0.8, 0.9), 0.75, 0)).toBe("WRONG");
    expect(classifyMargin(o(0.7, 0.6), 0.75, 0)).toBe("UNRESOLVED");
  });

  it("a skill with only one alias is UNMEASURABLE, not a miss", () => {
    // Leave-one-out leaves it unrepresented. Scoring it as a miss reports a retrieval defect
    // where there is only a thin corpus.
    expect(classifyMargin(o(null, 0.9), 0.75, 0)).toBe("UNMEASURABLE");
  });

  it("the separation rule fires whichever side is on top — it cannot know the answer first", () => {
    // A rule that only rejected close CALLS THAT ARE WRONG would already know the answer.
    expect(classifyMargin(o(0.9, 0.89), 0.75, 0.05)).toBe("UNRESOLVED");
    expect(classifyMargin(o(0.89, 0.9), 0.75, 0.05)).toBe("UNRESOLVED");
  });

  it("the floor is checked against the TOP of the two, not against the own score", () => {
    // Otherwise a wrong answer at 0.9 would be reported unresolved because the right one is low.
    expect(classifyMargin(o(0.3, 0.9), 0.75, 0)).toBe("WRONG");
  });

  it("no other skill in scope is not a rejection", () => {
    expect(classifyMargin(o(0.9, null), 0.75, 0.05)).toBe("CORRECT");
  });
});

describe("sweepSeparation reports the TRADE, not one side of it", () => {
  const obs = [o(0.90, 0.80), o(0.80, 0.90), o(0.90, 0.89)];

  it("baseline is always separation 0, so every delta is measured against today", () => {
    const [p] = sweepSeparation(obs, 0.75, [0]);
    expect(p).toMatchObject({ correct: 2, wrong: 1, unresolved: 0, lostCorrect: 0, rejectedWrong: 0 });
  });

  it("a rejection that removes a RIGHT answer is counted as a loss, in the same row", () => {
    const [p] = sweepSeparation(obs, 0.75, [0.05]);
    expect(p).toMatchObject({ correct: 1, wrong: 1, unresolved: 1, lostCorrect: 1, rejectedWrong: 0 });
  });

  it("separatingSeparation returns null when no swept value clears every wrong answer", () => {
    expect(separatingSeparation([o(0.8, 0.9)], 0.75, [0, 0.01])).toBeNull();
    expect(separatingSeparation([o(0.8, 0.9)], 0.75, [0, 0.2])).toBe(0.2);
  });
});

describe("the shared-token rule", () => {
  it("drops stopwords, or every Hinglish alias groups with every other", () => {
    expect(tokens("welding ka kaam")).toEqual(["welding"]);
    expect(sharesToken("welding ka kaam", "drilling ka kaam")).toBe(false);
  });

  it("catches process names that share a word", () => {
    expect(sharesToken("TIG welding", "MIG welding")).toBe(true);
  });

  it("and cannot see acronyms, which is the whole problem", () => {
    expect(sharesToken("GMAW", "SMAW")).toBe(false);
  });

  it("reports the worst pair as missed when the rule cannot see it", () => {
    const c = lexicalCoverage([
      { phrase: "GMAW", via: "SMAW", score: 0.8405 },
      { phrase: "TIG welding", via: "MIG welding", score: 0.8 },
    ]);
    expect(c.worstIsMissed).toBe(true);
    expect(c.caught).toEqual(["TIG welding / MIG welding"]);
  });
});

// ---------------------------------------------------------------------------
// THE COMMITTED MEASUREMENT
// ---------------------------------------------------------------------------
interface Sweep {
  separation: number;
  correct: number;
  wrong: number;
  lostCorrect: number;
  rejectedWrong: number;
}
interface Artifact {
  ai_spend_inr: number;
  floor: number;
  owner_decision: string;
  policy_implemented: null;
  probes: number;
  unmeasurable_single_alias_skills: number;
  at_floor: { correct: number; wrong: number; unresolved: number };
  margin_distribution: { correct: Record<string, number>; wrong: Record<string, number> };
  distributions_overlap: boolean;
  duplicate_text_pairs: number;
  separation_sweep: Sweep[];
  separation_sweep_duplicates_removed: Sweep[];
  smallest_separating_delta: number | null;
  smallest_separating_delta_duplicates_removed: number | null;
  misassignments_above_floor_count: number;
  misassignments_genuine_count: number;
  option_c_shared_token_rule: {
    pairs_considered: number;
    caught: string[];
    missed: string[];
    worst_pair_is_missed: boolean;
  };
  misassignments_above_floor: {
    phrase: string;
    want: string;
    got: string;
    other_score: number;
    margin: number;
    duplicate_text: boolean;
  }[];
  production_mutation_performed: boolean;
}

const art = JSON.parse(readFileSync(join(DOCS, "5a2-sibling-margin.json"), "utf8")) as Artifact;

describe("the measurement", () => {
  it("carries provenance, cost nothing, wrote nothing, decided nothing", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
    expect(art.owner_decision).toBe("PENDING");
    expect(art.policy_implemented).toBeNull();
  });

  it("106 probes, 2 unmeasurable because their skill has a single alias", () => {
    expect(art.probes).toBe(106);
    expect(art.unmeasurable_single_alias_skills).toBe(2);
  });

  it("leave-one-out resolves only 43 of 104 correctly above the floor", () => {
    // Not the sibling question, but it is the same instrument's most uncomfortable number and
    // it belongs on the record: 46 of 104 corpus phrases do not clear 0.75 without themselves.
    expect(art.at_floor).toEqual({ correct: 43, wrong: 15, unresolved: 46 });
  });
});

describe("OPTION B — a minimum separation, answered by arithmetic", () => {
  it("the two margin distributions OVERLAP, so no separation orders them apart", () => {
    // Right answers as close as 0.0000 to their runner-up; wrong ones as far as 0.2708.
    expect(art.distributions_overlap).toBe(true);
    expect(art.margin_distribution.correct["min"]).toBe(0);
    expect(art.margin_distribution.wrong["max"]).toBeCloseTo(0.2708, 4);
    expect(art.margin_distribution.correct["min"]!).toBeLessThan(art.margin_distribution.wrong["max"]!);
  });

  it("with duplicates present NO swept value eliminates the wrong answers", () => {
    expect(art.smallest_separating_delta).toBeNull();
  });

  it("with duplicates cleaned up the value is 0.15 — and it costs more than it saves", () => {
    // 26 correct resolutions destroyed to reject 7 wrong ones. Stated as the ratio because
    // "0.15 works" is true and useless without it.
    expect(art.smallest_separating_delta_duplicates_removed).toBe(0.15);
    const at = art.separation_sweep_duplicates_removed.find((p) => p.separation === 0.15)!;
    expect(at.wrong).toBe(0);
    expect(at.lostCorrect).toBe(26);
    expect(at.rejectedWrong).toBe(7);
    expect(at.lostCorrect).toBeGreaterThan(at.rejectedWrong * 3);
  });

  it("and even a tiny 0.005 already costs 3 right answers for 0 wrong ones rejected", () => {
    const at = art.separation_sweep_duplicates_removed.find((p) => p.separation === 0.005)!;
    expect(at.lostCorrect).toBe(3);
    expect(at.rejectedWrong).toBe(0);
  });
});

describe("OPTION C — a lexical rule misses the case it was proposed for", () => {
  it("the worst genuine pair is invisible to a shared-token rule", () => {
    expect(art.option_c_shared_token_rule.worst_pair_is_missed).toBe(true);
    expect(art.option_c_shared_token_rule.missed).toContain("GMAW / SMAW");
    expect(art.option_c_shared_token_rule.missed).toContain("GTAW / GMAW");
  });

  it("it catches 10 of 15 — useful, and not sufficient on its own", () => {
    const c = art.option_c_shared_token_rule;
    expect(c.pairs_considered).toBe(15);
    expect(c.caught).toHaveLength(10);
    expect(c.missed).toHaveLength(5);
  });
});

describe("what the D-7C-1 cleanup is and is not responsible for", () => {
  it("8 of the 15 misassignments are duplicate text and are the cleanup's, not the margin's", () => {
    expect(art.duplicate_text_pairs).toBe(8);
    expect(art.misassignments_above_floor_count).toBe(15);
    expect(art.misassignments_genuine_count).toBe(7);
    expect(art.misassignments_above_floor.filter((m) => m.duplicate_text)).toHaveLength(8);
  });

  it("the 7 that survive are welding acronyms and the quality-check family", () => {
    const genuine = art.misassignments_above_floor.filter((m) => !m.duplicate_text);
    expect(genuine.map((m) => m.phrase).sort()).toEqual([
      "GMAW",
      "GTAW",
      "SMAW",
      "TIG welding",
      "quality check",
      "quality check karna",
      "quality control",
    ]);
    expect(genuine[0]!.other_score).toBeCloseTo(0.8405, 4);
  });

  it("every genuine misassignment sits above the floor with a margin under 0.13", () => {
    for (const m of art.misassignments_above_floor.filter((x) => !x.duplicate_text)) {
      expect(m.other_score, m.phrase).toBeGreaterThanOrEqual(0.75);
      expect(m.margin, m.phrase).toBeLessThan(0.13);
    }
  });
});

describe("nothing was decided and nothing was implemented", () => {
  it("no separation parameter exists outside this audit", () => {
    const runtime = readFileSync(
      join(__dirname, "..", "..", "..", "apps", "ai-service", "app", "config.py"),
      "utf8",
    );
    expect(runtime).not.toMatch(/separation|min_margin|margin_floor/i);
  });

  it("the floor is still 0.75 in the measurement and in config.py", () => {
    expect(art.floor).toBe(0.75);
    const runtime = readFileSync(
      join(__dirname, "..", "..", "..", "apps", "ai-service", "app", "config.py"),
      "utf8",
    );
    expect(runtime).toMatch(/skill_canonicalize_floor/);
    expect(runtime).toContain("0.75");
  });
});

/**
 * The L0/L1 resolver and the gold-set scorer.
 *
 * TWO ORDERING PROPERTIES ARE LOAD-BEARING and both are tested by CONSTRUCTION — an
 * index built so that the wrong order gives a demonstrably wrong answer:
 *
 *  1. LONGEST SPAN FIRST. "gas welding" must beat "welding" when both are present.
 *     Shortest-first would silently discard the worker's own qualifier and pin a less
 *     specific occupation, which then selects a different question pack.
 *  2. L0 BEFORE L1, AT EVERY LENGTH. The skeleton fold is lossy on short words —
 *     driver/Drover, fitter/Father, painter/Pantry all collide — so a fuzzy match must
 *     never be reachable while an exact one exists anywhere in the utterance.
 *
 * A test that only asserts "welding resolves to the welding domain" would pass under both
 * broken orderings, which is why these are written as adversarial pairs instead.
 */
import { describe, expect, it } from "vitest";

import type { ResolvedJobDomain } from "./job-domain-corpus";
import {
  buildOccupationIndex,
  resolveOccupation,
  scoreGoldSet,
  scoreGoldSetByFamily,
  type GoldUtterance,
} from "./occupation-retrieval-eval";

function domain(id: string, unit: string, aliases: string[], selectable = true): ResolvedJobDomain {
  return {
    source: "nco2015",
    code: id,
    level: 5,
    parent_code: unit,
    parent_source: "isco08",
    isco_major: unit.slice(0, 1),
    isco_unit: unit,
    skill_level: 2,
    label_en: aliases[0] ?? id,
    label_hi: null,
    description_en: null,
    selectable,
    industry_id: null,
    canonical_role_id: null,
    aliases: aliases.map((text) => ({ text, lang: "en" as const, source: "rvm" as const })),
    jobDomainId: id,
    parentJobDomainId: null,
  };
}

describe("buildOccupationIndex", () => {
  it("indexes only selectable domains", () => {
    // A non-selectable row can never be `is_searchable`, so indexing it would inflate the
    // offline hit rate above what production could ever achieve.
    const index = buildOccupationIndex([domain("jd_a", "7212", ["welding"], false)]);
    expect(index.spans.exact.size).toBe(0);
  });

  it("keeps every domain claiming the same key rather than picking one", () => {
    // "mistri" is honestly ambiguous. Collapsing it here would hide a real disambiguation
    // problem that Phase 7 has to solve with family-level margins.
    const index = buildOccupationIndex([
      domain("jd_a", "7112", ["mistri"]),
      domain("jd_b", "7233", ["mistri"]),
    ]);
    expect(index.spans.exact.get("mistri")).toEqual(["jd_a", "jd_b"]);
  });

  it("skips aliases that normalize to nothing", () => {
    const index = buildOccupationIndex([domain("jd_a", "7212", ["- / -"])]);
    expect(index.spans.exact.size).toBe(0);
  });
});

describe("resolveOccupation", () => {
  it("finds a trade word buried mid-sentence", () => {
    const index = buildOccupationIndex([domain("jd_weld", "7212", ["welding"])]);
    const hit = resolveOccupation(index, "main pichhle char saal se welding ka kaam karta hoon");
    expect(hit?.jobDomainId).toBe("jd_weld");
    expect(hit?.layer).toBe("L0");
  });

  it("prefers the LONGER span when both match — the qualifier must survive", () => {
    const index = buildOccupationIndex([
      domain("jd_generic", "7212", ["welding"]),
      domain("jd_gas", "7212", ["gas welding"]),
    ]);
    const hit = resolveOccupation(index, "gas welding ka kaam aata hai");
    expect(hit?.jobDomainId).toBe("jd_gas");
    expect(hit?.spanTokens).toBe(2);
  });

  it("prefers an EXACT match anywhere over a skeleton match on a longer span", () => {
    // Adversarial by construction: "silai machine" would match jd_skel at L1 on two
    // tokens, while "welding" matches jd_exact at L0 on one. Length-before-layer would
    // return jd_skel; the correct ladder returns jd_exact.
    const index = buildOccupationIndex([
      domain("jd_exact", "7212", ["welding"]),
      domain("jd_skel", "8153", ["silai mashine"]),
    ]);
    const hit = resolveOccupation(index, "silai machine aur welding dono");
    expect(hit?.layer).toBe("L0");
    expect(hit?.jobDomainId).toBe("jd_exact");
  });

  it("falls through to L1 for a misspelling", () => {
    const index = buildOccupationIndex([domain("jd_weld", "7212", ["welder"])]);
    // w->v and a dropped vowel: the exact map cannot hold this, the skeleton can.
    const hit = resolveOccupation(index, "velder ka kaam");
    expect(hit?.layer).toBe("L1");
    expect(hit?.jobDomainId).toBe("jd_weld");
  });

  it("returns null when nothing matches", () => {
    const index = buildOccupationIndex([domain("jd_weld", "7212", ["welding"])]);
    expect(resolveOccupation(index, "kuch samajh nahi aaya")).toBeNull();
  });

  it("returns null for an utterance that normalizes to nothing", () => {
    const index = buildOccupationIndex([domain("jd_weld", "7212", ["welding"])]);
    expect(resolveOccupation(index, "!!!")).toBeNull();
  });

  it("never scans a span longer than the longest alias", () => {
    // Guards the cap: without it every utterance is O(tokens^2) for no possible gain,
    // because a span longer than any alias cannot match by definition.
    const index = buildOccupationIndex([domain("jd_weld", "7212", ["welding"])]);
    expect(index.spans.maxSpanTokens).toBe(1);
    expect(resolveOccupation(index, "a b c d e welding f g h")?.jobDomainId).toBe("jd_weld");
  });
});

describe("scoreGoldSet", () => {
  const index = buildOccupationIndex([
    domain("jd_weld", "7212", ["welding"]),
    domain("jd_tailor", "7531", ["silai"]),
  ]);

  it("scores a hit in the right unit as correct", () => {
    const gold: GoldUtterance[] = [{ utterance: "welding ka kaam", expect_unit: "7212" }];
    const r = scoreGoldSet(index, gold);
    expect(r).toMatchObject({ l0: 1, l1: 0, miss: 0, wrongUnit: 0, hitRate: 1 });
  });

  it("counts a hit in the WRONG unit as a failure, not a hit", () => {
    const gold: GoldUtterance[] = [{ utterance: "welding ka kaam", expect_unit: "7531" }];
    const r = scoreGoldSet(index, gold);
    expect(r.wrongUnit).toBe(1);
    expect(r.hitRate).toBe(0);
    expect(r.failures[0]?.got).toBe("jd_weld");
  });

  it("separates a miss from a wrong answer", () => {
    // These need different fixes — a miss wants a new alias, a wrong unit wants
    // disambiguation — so collapsing them into one number would hide which to do.
    const gold: GoldUtterance[] = [
      { utterance: "kuch aur hi kaam", expect_unit: "7212" },
      { utterance: "silai ka kaam", expect_unit: "7212" },
    ];
    const r = scoreGoldSet(index, gold);
    expect(r.miss).toBe(1);
    expect(r.wrongUnit).toBe(1);
  });

  it("scores at UNIT level, so a sibling occupation in the same unit is correct", () => {
    // The plan's reasoning: "Welder, Gas" vs "Welder, Electric" share a question pack, so
    // resolving to either is a success for the interview. Scoring at occupation level
    // would report failure for an outcome the product treats as correct.
    const twoWelders = buildOccupationIndex([
      domain("jd_gas", "7212", ["gas welding"]),
      domain("jd_arc", "7212", ["arc welding"]),
    ]);
    const r = scoreGoldSet(twoWelders, [{ utterance: "arc welding karta hun", expect_unit: "7212" }]);
    expect(r.hitRate).toBe(1);
  });

  it("reports precision separately from hit rate", () => {
    // Hit rate counts misses against you; precision does not. Phase 7's calibration is
    // precision-asymmetric — a wrong family makes every later question wrong — so the two
    // numbers must not be conflated.
    const gold: GoldUtterance[] = [
      { utterance: "welding ka kaam", expect_unit: "7212" },
      { utterance: "kuch aur hi kaam", expect_unit: "7212" },
    ];
    const r = scoreGoldSet(index, gold);
    expect(r.hitRate).toBe(0.5);
    expect(r.precision).toBe(1);
  });

  it("handles an empty gold set without dividing by zero", () => {
    expect(scoreGoldSet(index, [])).toMatchObject({ total: 0, hitRate: 0, precision: 0 });
  });
});

describe("scoreGoldSetByFamily — the Phase 7 acceptance criterion", () => {
  // "Welder, Gas" and "Welder, Electric" sit in DIFFERENT units but ONE family. That gap is
  // the whole reason this scorer exists: unit-level scoring calls the second a failure when
  // the interview it produces is identical.
  const index = buildOccupationIndex([
    domain("jd_gas", "7212", ["gas welder"]),
    domain("jd_arc", "7213", ["arc welder"]),
    domain("jd_tailor", "7531", ["darzi"]),
  ]);

  const familyOf = (_jobDomainId: string, unit: string | null): string | null => {
    if (unit === "7212" || unit === "7213") return "fam_welding";
    if (unit === "7531") return "fam_tailoring";
    return null;
  };

  it("counts a different UNIT in the same FAMILY as correct", () => {
    // Unit-level scoring marks this wrong; the worker gets the right pack either way.
    const r = scoreGoldSetByFamily(index, [{ utterance: "arc welder", expect_unit: "7212" }], familyOf);
    expect(r.correct).toBe(1);
    expect(r.wrongFamily).toBe(0);
    expect(r.precision).toBe(1);
  });

  it("counts a different FAMILY as wrong", () => {
    const r = scoreGoldSetByFamily(index, [{ utterance: "darzi", expect_unit: "7212" }], familyOf);
    expect(r.wrongFamily).toBe(1);
    expect(r.precision).toBe(0);
  });

  it("EXCLUDES gold rows whose expected unit binds to no family", () => {
    // A gold row labelled to an unbound unit is a gap in the PACK corpus, not a retrieval
    // error. Counting it would make the retrieval number move when pack authoring moved.
    const r = scoreGoldSetByFamily(index, [{ utterance: "darzi", expect_unit: "9999" }], familyOf);
    expect(r.unbound).toBe(1);
    expect(r.wrongFamily).toBe(0);
    expect(r.precision).toBe(0);
  });

  it("counts a miss separately from a wrong family", () => {
    // Precision is about what it ANSWERED. Silence is a coverage problem, not a precision one.
    const r = scoreGoldSetByFamily(
      index,
      [
        { utterance: "aaj mausam accha hai", expect_unit: "7212" },
        { utterance: "gas welder", expect_unit: "7212" },
      ],
      familyOf,
    );
    expect(r.miss).toBe(1);
    expect(r.correct).toBe(1);
    expect(r.precision).toBe(1);
    expect(r.coverage).toBe(0.5);
  });

  it("reports zero precision rather than NaN when nothing was attempted", () => {
    const r = scoreGoldSetByFamily(index, [{ utterance: "xyzzy", expect_unit: "7212" }], familyOf);
    expect(r.precision).toBe(0);
    expect(Number.isNaN(r.precision)).toBe(false);
  });

  it("records every failure with both the expected and the resolved family", () => {
    const r = scoreGoldSetByFamily(index, [{ utterance: "darzi", expect_unit: "7212" }], familyOf);
    expect(r.failures[0]).toMatchObject({
      expectedFamily: "fam_welding",
      gotFamily: "fam_tailoring",
      got: "jd_tailor",
    });
  });
});

describe("scoreGoldSetByFamily — a MORE SPECIFIC family under the same unit", () => {
  /**
   * THE CASE THE METRIC COULD NOT EXPRESS UNTIL A SUB-UNIT FAMILY EXISTED.
   *
   * The gold set is labelled to an ISCO unit, so the expected family is resolved through a
   * synthetic domain id and can only ever match a unit-and-above binding. `fam_cnc_turning`
   * binds by `job_domain_id` INSIDE unit 7223, alongside `fam_machining` which binds the whole
   * unit — so every utterance that family exists to serve ("kharad", "lathe machine", "cnc
   * turning ka kaam") scored as a WRONG FAMILY, permanently and by construction, while the
   * retrieval was in fact rightER than the label. Measured on the branch that added it: ten
   * such rows, family precision 98.2% -> 95.7%, under a 97.0% floor.
   *
   * The pair below is the whole contract, and the second half is the one that matters: this
   * must not become a way for a real cross-trade error to score as correct.
   */
  const index = buildOccupationIndex([
    domain("jd_lathe", "7223", ["kharad"]),
    domain("jd_mill", "7223", ["milling machine"]),
    domain("jd_tailor", "7531", ["darzi"]),
  ]);

  // Domain-level binding for the lathe only, exactly as `_families.jsonl` binds the turner.
  const familyOf = (jobDomainId: string, unit: string | null): string | null => {
    if (jobDomainId === "jd_lathe") return "fam_cnc_turning";
    if (unit === "7223") return "fam_machining";
    if (unit === "7531") return "fam_tailoring";
    return null;
  };

  it("counts it as correct, and reports it as a refinement rather than silently", () => {
    const r = scoreGoldSetByFamily(index, [{ utterance: "kharad", expect_unit: "7223" }], familyOf);
    expect(r.wrongFamily).toBe(0);
    expect(r.refined).toBe(1);
    expect(r.precision).toBe(1);
    // Counted, but never invisible: a binding authored at the wrong granularity would move
    // utterances into a new family without moving the number, so the list is the only signal.
    expect(r.refinements[0]).toMatchObject({
      expectedFamily: "fam_machining",
      gotFamily: "fam_cnc_turning",
    });
  });

  it("STILL fails a different unit — the rule cannot launder a real cross-trade error", () => {
    // THE LOAD-BEARING HALF. If "same unit" were dropped from the test, this would score as a
    // refinement too and the whole criterion would be worthless.
    const r = scoreGoldSetByFamily(index, [{ utterance: "darzi", expect_unit: "7223" }], familyOf);
    expect(r.refined).toBe(0);
    expect(r.wrongFamily).toBe(1);
    expect(r.precision).toBe(0);
  });

  it("does not turn a same-unit sibling into a refinement when the family is unchanged", () => {
    // Milling has no domain binding, so it resolves to the unit family and is an exact match.
    // A refinement must require an actual difference, not merely a shared unit.
    const r = scoreGoldSetByFamily(
      index,
      [{ utterance: "milling machine", expect_unit: "7223" }],
      familyOf,
    );
    expect(r.correct).toBe(1);
    expect(r.refined).toBe(0);
  });
});

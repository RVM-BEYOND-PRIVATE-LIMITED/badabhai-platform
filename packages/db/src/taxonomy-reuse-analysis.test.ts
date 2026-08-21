/**
 * `analyzeReuse` — proving the DETECTOR works, before there is any generated data to point
 * it at.
 *
 * WHAT THESE TESTS ARE FOR. The whole value of this analyzer is its two accusing categories,
 * and both of them are accusations a generator would never make about itself: FALSE_REUSE
 * says "you merged two concepts and reported it as a confident reuse", MISSED_REUSE says
 * "you minted a row for something you already had". A detector that has only ever been run
 * against well-formed input is indistinguishable from one that returns CORRECT_* for
 * everything — which is exactly the report a broken generator would produce, and exactly the
 * report nobody would question.
 *
 * So every category is pinned from BOTH directions: the bad record is caught, and the good
 * record that superficially resembles it is NOT. The second half is the expensive one to get
 * right and the one that decides whether the report is worth reading — an over-eager
 * accusation trains a reviewer to skim, and a skimmed report hides the real findings.
 *
 * They assert on the CATEGORY and the EVIDENCE PREFIX, never on prose. Same discipline as
 * `taxonomy-corpus.test.ts`: the sentence is for the human who has to fix the corpus and
 * should be free to improve; the category is what a manifest counts by.
 *
 * NO REAL TAXONOMY DATA IS CREATED HERE. Every record below is a synthetic fixture that
 * exists to make a detector fire.
 */
import { describe, expect, it } from "vitest";

import {
  REUSE_CATEGORIES,
  THIN_COVERAGE_THRESHOLD,
  analyzeReuse,
  candidateShippedSkills,
  tradeGroupTokens,
  type ReuseAnalysis,
  type ReuseDecision,
} from "./taxonomy-reuse-analysis";
import {
  skillLocator,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";
import {
  shippedSkillViews,
  surfaceOfShippedSkill,
  type ShippedSkillView,
} from "./taxonomy-lexical";

// ===========================================================================
// Fixtures
// ===========================================================================

const CNC_TURNING = "jd_nco_7223_6002";
const CNC_PROGRAMMER = "jd_nco_7223_6003";
const STONE_MASON = "jd_nco_7112_0100";
const ASSISTANT_MASON = "jd_nco_7112_0601";

const DOMAINS: TaxonomyDomainRecord[] = [
  { job_domain_id: CNC_TURNING, label_en: "CNC Operator-Turning", trade_group: "cnc_machining" },
  { job_domain_id: CNC_PROGRAMMER, label_en: "CNC Programmer", trade_group: "cnc_machining" },
  { job_domain_id: STONE_MASON, label_en: "Stone Mason", trade_group: "construction" },
  { job_domain_id: ASSISTANT_MASON, label_en: "Assistant Mason", trade_group: "construction" },
];

/**
 * A synthetic SHIPPED vocabulary.
 *
 * Injected rather than read from `SKILL_CORPUS` for the same reason the validator lets a
 * test inject `existingSkillIds`: a test that depends on which ids happen to ship this month
 * fails for a reason that has nothing to do with the code it covers. The default path (the
 * real corpus) gets its own test at the bottom.
 */
const SHIPPED: ShippedSkillView[] = [
  { skill_id: "skill_fanuc", label_en: "Fanuc control operation", aliases: ["Fanuc", "Fanuc controller"] },
  { skill_id: "skill_turning", label_en: "Turning (lathe operation)", aliases: ["turning", "CNC turning"] },
  {
    skill_id: "skill_dimensional_inspection",
    label_en: "Dimensional inspection",
    aliases: ["inspection", "dimensional inspection"],
  },
  {
    skill_id: "skill_grinding_ops",
    label_en: "Grinding (surface / cylindrical)",
    aliases: ["grinding", "surface grinding"],
  },
];

function skill(overrides: Partial<TaxonomySkillRecord> = {}): TaxonomySkillRecord {
  return {
    kind: "skill",
    skill_id: "skill_turret_indexing",
    label_en: "Turret Indexing",
    label_hi: null,
    aliases: [{ text: "turret index", lang: "en" }],
    ...overrides,
  };
}

function edge(overrides: Partial<TaxonomyDomainSkillRecord> = {}): TaxonomyDomainSkillRecord {
  return {
    kind: "domain_skill",
    job_domain_id: CNC_TURNING,
    skill_id: "skill_turret_indexing",
    default_requirement: "required",
    relevance: 80,
    confidence: 0.8,
    source: "llm_bootstrap",
    ...overrides,
  };
}

/** Run the analyzer with the synthetic shipped set and no validator problems unless asked. */
function analyze(
  skills: TaxonomySkillRecord[],
  edges: TaxonomyDomainSkillRecord[],
  opts: { problems?: string[]; shipped?: ShippedSkillView[]; domains?: TaxonomyDomainRecord[] } = {},
): ReuseAnalysis {
  return analyzeReuse(skills, edges, {
    domains: opts.domains ?? DOMAINS,
    shipped: opts.shipped ?? SHIPPED,
    problems: opts.problems ?? [],
  });
}

function decisionFor(analysis: ReuseAnalysis, skillId: string): ReuseDecision {
  const found = analysis.decisions.find((d) => d.skill_id === skillId);
  expect(found, `no decision for ${skillId}`).toBeDefined();
  return found as ReuseDecision;
}

// ===========================================================================
// 1 + 2 — the two ways of being right
// ===========================================================================

describe("analyzeReuse — CORRECT_REUSE / CORRECT_NEW", () => {
  it("classifies an edge onto a shipped skill as CORRECT_REUSE", () => {
    // The NORMAL shape of a reuse: no skill record at all, just an edge naming the shipped
    // id. There is nothing to accuse anyone of here and the analyzer must say so plainly.
    const analysis = analyze([], [edge({ skill_id: "skill_fanuc" })]);
    const d = decisionFor(analysis, "skill_fanuc");
    expect(d.category).toBe("CORRECT_REUSE");
    expect(d.matched_existing_skill_id).toBe("skill_fanuc");
    expect(d.confidence_signal).toBe("none");
    expect(d.evidence).toEqual([]);
  });

  it("classifies a genuinely novel skill as CORRECT_NEW", () => {
    const analysis = analyze([skill()], [edge()]);
    const d = decisionFor(analysis, "skill_turret_indexing");
    expect(d.category).toBe("CORRECT_NEW");
    expect(d.matched_existing_skill_id).toBeNull();
    expect(d.confidence_signal).toBe("none");
  });

  it("does NOT call a new skill a missed reuse for sharing one generic token", () => {
    // "operation" is in GENERIC_SKILL_STOPLIST and is therefore not evidence of anything —
    // shipped "Turning (lathe operation)" shares it, and a detector that counted that would
    // accuse most of the corpus.
    const analysis = analyze(
      [skill({ skill_id: "skill_coolant_operation", label_en: "Coolant Operation", aliases: [{ text: "coolant", lang: "en" }] })],
      [edge({ skill_id: "skill_coolant_operation" })],
    );
    expect(decisionFor(analysis, "skill_coolant_operation").category).toBe("CORRECT_NEW");
  });
});

// ===========================================================================
// 4 — MISSED_REUSE, derived from the SHIPPED corpus (not from the generator)
// ===========================================================================

// 4b — MISSED_REUSE, WITHIN THE BATCH. The direction an against-catalogue check is
// structurally blind to, and the one that produced a real miss before it was added.
describe("analyzeReuse — MISSED_REUSE within a single batch", () => {
  /**
   * THE REGRESSION THIS EXISTS FOR, and it was a live gap, not a hypothetical.
   *
   * Before the sibling comparison landed, `analyzeReuse` compared every NEW skill only
   * against the SHIPPED corpus. Two new skills minted in the SAME batch for one concept are
   * both absent from that corpus, so both came back CORRECT_NEW — a clean bill of health for
   * a batch that had duplicated itself. Verified at the time with exactly this shape:
   * "Hydraulic Hose Crimping" and "Crimping Hydraulic Hose" both scored CORRECT_NEW.
   *
   * `detectConvergence` does not cover it either: that only inspects concepts a caller
   * declared as a probe inside a named group, so a duplicate pair outside those groups is
   * invisible to both checks at once.
   *
   * BOTH members are reported, deliberately. Which of a duplicate pair is "the original" is
   * not knowable here — reporting one would silently nominate a survivor.
   */
  it("flags BOTH members of a pure re-ordering minted in the same batch", () => {
    const a = skill({
      skill_id: "skill_hydraulic_hose_crimping",
      label_en: "Hydraulic Hose Crimping",
      aliases: [{ text: "hose crimping", lang: "en" }],
    });
    const b = skill({
      skill_id: "skill_crimping_hydraulic_hose",
      label_en: "Crimping Hydraulic Hose",
      aliases: [{ text: "hydraulic crimping", lang: "en" }],
    });
    const report = analyzeReuse(
      [a, b],
      [
        edge({ skill_id: a.skill_id, job_domain_id: CNC_TURNING }),
        edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER }),
      ],
      { domains: DOMAINS, shipped: SHIPPED },
    );

    const byId = new Map(report.decisions.map((d) => [d.skill_id, d]));
    for (const id of [a.skill_id, b.skill_id]) {
      const d = byId.get(id);
      expect(d?.category, `${id} must not pass as CORRECT_NEW`).toBe("MISSED_REUSE");
      expect(d?.confidence_signal).toBe("confident");
      // The evidence must say WHERE the twin came from — a reviewer chasing a shipped id
      // that does not exist is worse than no evidence at all.
      expect(d?.evidence.some((e) => e.startsWith("WITHIN_BATCH:"))).toBe(true);
    }
    // Each points at the other, so the pair is navigable from either end.
    expect(byId.get(a.skill_id)?.matched_existing_skill_id).toBe(b.skill_id);
    expect(byId.get(b.skill_id)?.matched_existing_skill_id).toBe(a.skill_id);
  });

  it("prefers a SHIPPED match over a sibling when both exist", () => {
    // A shipped equivalent is the more actionable finding: reusing it removes a row from the
    // batch outright, whereas merging two new rows still leaves a new skill to review.
    const a = skill({ skill_id: "skill_cnc_turning_ops", label_en: "CNC Turning", aliases: [{ text: "cnc turning", lang: "en" }] });
    const b = skill({ skill_id: "skill_turning_cnc", label_en: "Turning CNC", aliases: [{ text: "turning cnc", lang: "en" }] });
    const report = analyzeReuse(
      [a, b],
      [edge({ skill_id: a.skill_id }), edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER })],
      { domains: DOMAINS, shipped: SHIPPED },
    );
    const d = report.decisions.find((x) => x.skill_id === a.skill_id);
    expect(d?.category).toBe("MISSED_REUSE");
    expect(d?.matched_existing_skill_id).toBe("skill_turning"); // the shipped id, not the sibling
    expect(d?.evidence.some((e) => e.startsWith("LEXICAL:"))).toBe(true);
  });

  it("does NOT flag two genuinely distinct new skills in one batch", () => {
    // The false-positive guard. Same trade, same batch, unrelated concepts — a detector that
    // merged these would push the generator toward an under-specified taxonomy.
    const a = skill({ skill_id: "skill_turret_indexing", label_en: "Turret Indexing", aliases: [{ text: "turret index", lang: "en" }] });
    const b = skill({ skill_id: "skill_coolant_management", label_en: "Coolant Management", aliases: [{ text: "coolant top-up", lang: "en" }] });
    const report = analyzeReuse(
      [a, b],
      [edge({ skill_id: a.skill_id }), edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER })],
      { domains: DOMAINS, shipped: SHIPPED },
    );
    for (const d of report.decisions) {
      expect(d.category, `${d.skill_id} was wrongly accused`).toBe("CORRECT_NEW");
    }
  });

  it("does not compare a REUSE record against its siblings", () => {
    // A record pointing at a shipped id is not "a new skill that should have reused
    // something" — it already did.
    const reuse = skill({ skill_id: "skill_turning", label_en: "Turning (lathe operation)", reuses_existing: true });
    const fresh = skill({ skill_id: "skill_turning_work", label_en: "Turning Work", aliases: [{ text: "turning work", lang: "en" }] });
    const report = analyzeReuse(
      [reuse, fresh],
      [edge({ skill_id: reuse.skill_id }), edge({ skill_id: fresh.skill_id, job_domain_id: CNC_PROGRAMMER })],
      { domains: DOMAINS, shipped: SHIPPED },
    );
    expect(report.decisions.find((d) => d.skill_id === "skill_turning")?.category).toBe("CORRECT_REUSE");
  });
});

describe("analyzeReuse — MISSED_REUSE", () => {
  it("catches a new skill whose normalized label is already a shipped label", () => {
    const analysis = analyze(
      [
        skill({
          skill_id: "skill_dimensional_inspection_v2",
          label_en: "  dimensional,  Inspection  ",
          aliases: [{ text: "dim inspection", lang: "en" }],
        }),
      ],
      [edge({ skill_id: "skill_dimensional_inspection_v2" })],
    );
    const d = decisionFor(analysis, "skill_dimensional_inspection_v2");
    expect(d.category).toBe("MISSED_REUSE");
    expect(d.matched_existing_skill_id).toBe("skill_dimensional_inspection");
    expect(d.confidence_signal).toBe("confident");
    expect(d.evidence[0]).toContain("LEXICAL:normalized_label_equal");
  });

  it("catches a new skill whose ALIAS is already a shipped alias", () => {
    // The label is novel; the alias is not. A worker typing "fanuc controller" would now be
    // canonicalized to a coin flip, which is the whole reason this is a finding.
    const analysis = analyze(
      [
        skill({
          skill_id: "skill_control_panel_operation",
          label_en: "Control Panel Operation",
          aliases: [{ text: "Fanuc controller", lang: "en" }],
        }),
      ],
      [edge({ skill_id: "skill_control_panel_operation" })],
    );
    const d = decisionFor(analysis, "skill_control_panel_operation");
    expect(d.category).toBe("MISSED_REUSE");
    expect(d.matched_existing_skill_id).toBe("skill_fanuc");
    expect(d.evidence[0]).toContain("LEXICAL:surface_form_shared");
  });

  it("catches a re-ordered label with the same informative tokens", () => {
    // Shipped "Turning (lathe operation)" keeps {turning, lathe} after the stoplist drops
    // "operation". "Lathe Turning" is the same two words in the other order, which is the
    // most common way one concept acquires a second row.
    const analysis = analyze(
      [
        skill({
          skill_id: "skill_lathe_turning",
          label_en: "Lathe Turning",
          aliases: [{ text: "lathe turn", lang: "en" }],
        }),
      ],
      [edge({ skill_id: "skill_lathe_turning" })],
    );
    const d = decisionFor(analysis, "skill_lathe_turning");
    expect(d.category).toBe("MISSED_REUSE");
    expect(d.matched_existing_skill_id).toBe("skill_turning");
    expect(d.evidence[0]).toContain("LEXICAL:informative_tokens_equal");
  });

  it("catches a bounded strict token-subset of a shipped label", () => {
    const analysis = analyze(
      [
        skill({
          skill_id: "skill_final_dimensional_inspection",
          label_en: "Final Dimensional Inspection",
          aliases: [{ text: "final dim inspection", lang: "en" }],
        }),
      ],
      [edge({ skill_id: "skill_final_dimensional_inspection" })],
    );
    const d = decisionFor(analysis, "skill_final_dimensional_inspection");
    expect(d.category).toBe("MISSED_REUSE");
    expect(d.matched_existing_skill_id).toBe("skill_dimensional_inspection");
    expect(d.evidence[0]).toContain("LEXICAL:strict_token_subset");
  });

  it("never accuses a REUSE decision of being a missed reuse", () => {
    // A shipped id referenced by an edge cannot, by definition, have missed itself. This is
    // the guard that stops the strongest signal in the file firing on the healthiest case.
    const analysis = analyze([], [edge({ skill_id: "skill_turning" })]);
    expect(decisionFor(analysis, "skill_turning").category).toBe("CORRECT_REUSE");
  });
});

// ===========================================================================
// 3 — FALSE_REUSE, from evidence the generator did not produce
// ===========================================================================

describe("analyzeReuse — FALSE_REUSE from CONSUMED validator problems", () => {
  const twoSkillsOneAlias: TaxonomySkillRecord[] = [
    skill({
      skill_id: "skill_fanuc_cnc",
      label_en: "Fanuc CNC",
      aliases: [{ text: "fanuc", lang: "en" }],
    }),
    skill({
      skill_id: "skill_fanuc_alarms",
      label_en: "Fanuc Alarm Handling",
      aliases: [{ text: "Fanuc", lang: "en" }],
    }),
  ];
  const bothEdges = [edge({ skill_id: "skill_fanuc_cnc" }), edge({ skill_id: "skill_fanuc_alarms" })];

  it("reports FALSE_REUSE when the validator says ALIAS_AMBIGUOUS", () => {
    // No `problems` override: the analyzer calls `validateTaxonomyCorpus` itself. Shipped is
    // emptied so the two ids do not also collide with the real corpus.
    const analysis = analyzeReuse(twoSkillsOneAlias, bothEdges, { domains: DOMAINS, shipped: [] });
    expect(analysis.consumed_problem_codes["ALIAS_AMBIGUOUS"]).toBe(1);
    const flagged = analysis.decisions.filter((d) => d.category === "FALSE_REUSE");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.confidence_signal).toBe("confident");
    expect(flagged[0]?.evidence[0]).toContain("VALIDATOR:ALIAS_AMBIGUOUS");
  });

  it("CONSUMES that result rather than recomputing it — with the problems suppressed, nothing fires", () => {
    // The same two records, the same shared alias, the same lexical facts. The ONLY thing
    // removed is the validator's output. If the analyzer had its own private copy of the
    // ambiguity rule this would still report FALSE_REUSE, and the two definitions of
    // "ambiguous" would then be free to drift apart — with the copy that drifts being the
    // one that never gates a seed.
    const analysis = analyzeReuse(twoSkillsOneAlias, bothEdges, {
      domains: DOMAINS,
      shipped: [],
      problems: [],
    });
    expect(analysis.decisions.filter((d) => d.category === "FALSE_REUSE")).toEqual([]);
    expect(analysis.consumed_problem_codes).toEqual({});
  });

  it("reports FALSE_REUSE for a lexically SPOTLESS skill when the validator says so", () => {
    // The converse proof: this record has one coherent alias and could not possibly be
    // accused on lexical grounds. The finding comes entirely from the injected problem, so
    // the analyzer is demonstrably reading the validator rather than agreeing with it by
    // coincidence.
    const problems = [
      `${skillLocator("skill_turret_indexing")}: SKILL_LABEL_COLLIDES — normalizes the same as skill_other.`,
    ];
    const analysis = analyze([skill()], [edge()], { problems });
    const d = decisionFor(analysis, "skill_turret_indexing");
    expect(d.category).toBe("FALSE_REUSE");
    expect(d.evidence[0]).toContain("VALIDATOR:SKILL_LABEL_COLLIDES");
    expect(analysis.consumed_problem_codes["SKILL_LABEL_COLLIDES"]).toBe(1);
  });

  it("ignores validator codes that are not reuse evidence", () => {
    // SKILL_ORPHAN is a real problem and is emphatically not a false reuse. Folding every
    // code into the accusation would make the category meaningless.
    const problems = [`${skillLocator("skill_turret_indexing")}: SKILL_ORPHAN — zero domain_skill edges.`];
    const analysis = analyze([skill()], [edge()], { problems });
    expect(decisionFor(analysis, "skill_turret_indexing").category).toBe("CORRECT_NEW");
    expect(analysis.consumed_problem_codes).toEqual({});
  });
});

describe("analyzeReuse — FALSE_REUSE from alias-cluster divergence", () => {
  it("reports two disjoint alias groups on one skill as concepts wrongly collapsed", () => {
    // The physical residue of a merge: the row now carries the vocabulary of two trades that
    // share nothing with each other or with the canonical label. A generator reports this as
    // one confident reuse; the aliases say otherwise.
    const merged = skill({
      skill_id: "skill_fanuc_cnc",
      label_en: "Fanuc CNC",
      aliases: [
        { text: "fanuc control", lang: "en" },
        { text: "coolant flush", lang: "en" },
        { text: "coolant top up", lang: "en" },
        { text: "chuck jaw setting", lang: "en" },
        { text: "chuck jaw change", lang: "en" },
      ],
    });
    const analysis = analyze([merged], [edge({ skill_id: "skill_fanuc_cnc" })]);
    const d = decisionFor(analysis, "skill_fanuc_cnc");
    expect(d.category).toBe("FALSE_REUSE");
    expect(d.confidence_signal).toBe("confident");
    expect(d.evidence.every((e) => e.startsWith("LEXICAL:alias_cluster_divergence"))).toBe(true);
  });

  it("does NOT flag a lone lexically-unrelated alias — that is what a synonym IS", () => {
    // "GMAW" shares nothing with "MIG welding" and is the single most correct alias in the
    // shipped corpus. A detector that fired here would fire on most of it.
    const analysis = analyze(
      [
        skill({
          skill_id: "skill_mig_welding_local",
          label_en: "MIG Welding",
          aliases: [
            { text: "mig weld", lang: "en" },
            { text: "gmaw", lang: "en" },
          ],
        }),
      ],
      [edge({ skill_id: "skill_mig_welding_local" })],
    );
    expect(decisionFor(analysis, "skill_mig_welding_local").category).toBe("CORRECT_NEW");
  });
});

// ===========================================================================
// 5 — the category that protects the other four
// ===========================================================================

describe("analyzeReuse — POTENTIAL_AMBIGUITY is preferred over a weak accusation", () => {
  it("downgrades a partial overlap with a shipped skill to category 5, not MISSED_REUSE", () => {
    // {cylindrical, grinding, setup} against shipped {grinding, surface, cylindrical}: two of
    // three shared, neither containing the other, no alias in common. It might be the same
    // concept. It might be the setup step as opposed to the operation. The machine does not
    // know, and saying so is the honest output.
    const analysis = analyze(
      [
        skill({
          skill_id: "skill_cylindrical_grinding_setup",
          label_en: "Cylindrical Grinding Setup",
          aliases: [{ text: "cylindrical grind setup", lang: "en" }],
        }),
      ],
      [edge({ skill_id: "skill_cylindrical_grinding_setup" })],
    );
    const d = decisionFor(analysis, "skill_cylindrical_grinding_setup");
    expect(d.category).toBe("POTENTIAL_AMBIGUITY");
    expect(d.confidence_signal).toBe("worth_looking_at");
    expect(d.matched_existing_skill_id).toBe("skill_grinding_ops");
    expect(d.evidence[0]).toContain("LEXICAL:high_token_overlap");
  });

  it("downgrades a SINGLE divergent alias group to category 5, not FALSE_REUSE", () => {
    const analysis = analyze(
      [
        skill({
          skill_id: "skill_spindle_alignment",
          label_en: "Spindle Alignment",
          aliases: [
            { text: "spindle align", lang: "en" },
            { text: "coolant flush", lang: "en" },
            { text: "coolant top up", lang: "en" },
          ],
        }),
      ],
      [edge({ skill_id: "skill_spindle_alignment" })],
    );
    const d = decisionFor(analysis, "skill_spindle_alignment");
    expect(d.category).toBe("POTENTIAL_AMBIGUITY");
    expect(d.confidence_signal).toBe("worth_looking_at");
  });

  it("holds the invariant across a mixed corpus: an accusation is ALWAYS confident", () => {
    // The property, not an example: no category 3 or 4 may ever be emitted on weak evidence,
    // and no category 5 may ever be emitted as though it were proven.
    const analysis = analyze(
      [
        skill(),
        skill({ skill_id: "skill_lathe_turning", label_en: "Lathe Turning", aliases: [{ text: "lathe turn", lang: "en" }] }),
        skill({
          skill_id: "skill_turning_cycle_setup",
          label_en: "Turning Cycle",
          aliases: [{ text: "turning cycle", lang: "en" }],
        }),
      ],
      [
        edge(),
        edge({ skill_id: "skill_lathe_turning" }),
        edge({ skill_id: "skill_turning_cycle_setup" }),
        edge({ skill_id: "skill_fanuc" }),
      ],
    );
    expect(analysis.decisions.length).toBeGreaterThan(0);
    for (const d of analysis.decisions) {
      if (d.category === "FALSE_REUSE" || d.category === "MISSED_REUSE") {
        expect(d.confidence_signal).toBe("confident");
        expect(d.evidence.length).toBeGreaterThan(0);
      }
      if (d.category === "POTENTIAL_AMBIGUITY") expect(d.confidence_signal).toBe("worth_looking_at");
      if (d.category === "CORRECT_REUSE" || d.category === "CORRECT_NEW") {
        expect(d.confidence_signal).toBe("none");
      }
    }
  });
});

// ===========================================================================
// The report contract
// ===========================================================================

describe("analyzeReuse — the report contract", () => {
  it("assigns EXACTLY ONE category per decided skill id, and totals them all", () => {
    const analysis = analyze(
      [skill(), skill({ skill_id: "skill_lathe_turning", label_en: "Lathe Turning" })],
      [edge(), edge({ skill_id: "skill_lathe_turning" }), edge({ skill_id: "skill_fanuc" })],
    );
    expect(analysis.decisions).toHaveLength(3);
    expect(new Set(analysis.decisions.map((d) => d.skill_id)).size).toBe(3);
    expect(Object.keys(analysis.totals).sort()).toEqual([...REUSE_CATEGORIES].sort());
    const summed = Object.values(analysis.totals).reduce((a, b) => a + b, 0);
    expect(summed).toBe(analysis.decisions.length);
  });

  it("NEVER emits a global reuse_rate — the brief forbids it and so does the shipped corpus", () => {
    // A blended percentage over all trades reads as a verdict on the generator. It is not
    // one: three of the groups below have no shipped coverage at all, so their "reuse" was
    // never on offer. The per-group rows are the only honest shape.
    const analysis = analyze([skill()], [edge(), edge({ skill_id: "skill_fanuc" })]);
    expect(Object.keys(analysis).sort()).toEqual([
      "by_trade_group",
      "consumed_problem_codes",
      "decisions",
      "shipped_skill_count",
      "skipped_unknown_skill_ids",
      "totals",
    ]);
    const serialized = JSON.stringify(analysis);
    expect(serialized).not.toContain("reuse_rate");
    expect(serialized).not.toContain("overall_reuse");
    // And no key anywhere in the tree is a rate.
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v === null || typeof v !== "object") return;
      for (const [k, child] of Object.entries(v)) {
        keys.push(k);
        walk(child);
      }
    };
    walk(analysis);
    expect(keys.filter((k) => /rate$/.test(k))).toEqual([]);
  });

  it("files an edge to an unknown skill as skipped, not as a category", () => {
    // That record is the validator's EDGE_UNKNOWN_SKILL. Counting it as CORRECT_NEW would
    // inflate the healthy totals with a row that does not exist.
    const analysis = analyze([], [edge({ skill_id: "skill_invented_by_a_model" })]);
    expect(analysis.decisions).toEqual([]);
    expect(analysis.skipped_unknown_skill_ids).toEqual(["skill_invented_by_a_model"]);
  });

  it("is pure — the same inputs produce a deep-equal report", () => {
    const args = [[skill()], [edge(), edge({ skill_id: "skill_fanuc" })]] as const;
    expect(analyze([...args[0]], [...args[1]])).toEqual(analyze([...args[0]], [...args[1]]));
  });
});

// ===========================================================================
// The starting-corpus limitation
// ===========================================================================

describe("analyzeReuse — the starting-corpus limitation, per trade group", () => {
  it("reports one row per trade group, sorted, never one blended number", () => {
    const analysis = analyze([skill()], [edge()]);
    expect(analysis.by_trade_group.map((g) => g.trade_group)).toEqual([
      "cnc_machining",
      "construction",
    ]);
    for (const g of analysis.by_trade_group) {
      expect(g.job_domain_ids.length).toBeGreaterThan(0);
      expect(typeof g.available_candidate_skills).toBe("number");
      expect(typeof g.actual_reuse).toBe("number");
    }
  });

  it("reports NULL, never zero, when the shipped corpus does not cover the group", () => {
    // The finding this whole section exists for. Masonry has no shipped coverage: a `0.0`
    // here would be read as "the generator refused to reuse", when the truth is "there was
    // nothing to reuse". Null cannot be misread as a score.
    const analysis = analyze(
      [skill({ skill_id: "skill_stone_dressing", label_en: "Stone Dressing" })],
      [edge({ job_domain_id: STONE_MASON, skill_id: "skill_stone_dressing" })],
    );
    const construction = analysis.by_trade_group.find((g) => g.trade_group === "construction");
    expect(construction?.available_candidate_skills).toBe(0);
    expect(construction?.reuse_opportunity_ratio).toBeNull();
    expect(construction?.limitation).toBe("no_shipped_coverage");
    expect(construction?.new_skills).toBe(1);
  });

  it("reports a real ratio for a group the shipped corpus DOES cover", () => {
    const analysis = analyze([], [edge({ skill_id: "skill_fanuc" }), edge({ skill_id: "skill_turning" })]);
    const cnc = analysis.by_trade_group.find((g) => g.trade_group === "cnc_machining");
    expect(cnc?.actual_reuse).toBe(2);
    expect(cnc?.available_candidate_skills).toBeGreaterThanOrEqual(2);
    expect(cnc?.reuse_opportunity_ratio).not.toBeNull();
    expect(cnc?.reuse_opportunity_ratio as number).toBeGreaterThan(0);
    expect(cnc?.reuse_opportunity_ratio as number).toBeLessThanOrEqual(1);
  });

  it("can never report a ratio above 1, even when the lexical heuristic misses a candidate", () => {
    // `skill_dimensional_inspection` shares no token with a CNC job title, so the lexical
    // candidate scan would not offer it to this group. It was nonetheless reused there, and
    // a skill that WAS reused was self-evidently available — hence the union in
    // `buildTradeGroupReports`. Without it the denominator understates and the ratio exceeds
    // 1, which would make the whole column look broken.
    const analysis = analyze([], [edge({ skill_id: "skill_dimensional_inspection" })]);
    const cnc = analysis.by_trade_group.find((g) => g.trade_group === "cnc_machining");
    expect(cnc?.candidate_skill_ids).toContain("skill_dimensional_inspection");
    expect(cnc?.reuse_opportunity_ratio as number).toBeLessThanOrEqual(1);
  });

  it("names thin coverage as thin rather than letting one candidate look like a corpus", () => {
    const analysis = analyzeReuse([], [edge({ skill_id: "skill_fanuc" })], {
      domains: DOMAINS,
      shipped: [SHIPPED[0] as ShippedSkillView],
      problems: [],
    });
    const cnc = analysis.by_trade_group.find((g) => g.trade_group === "cnc_machining");
    expect(cnc?.available_candidate_skills).toBeLessThan(THIN_COVERAGE_THRESHOLD);
    expect(cnc?.limitation).toBe("thin_shipped_coverage");
  });

  it("builds group tokens from the domain labels AND the group name, minus generic words", () => {
    const tokens = tradeGroupTokens("quality_inspection", [
      { job_domain_id: "jd_nco_7543_2001", label_en: "Quality Inspector-forged components", trade_group: "quality_inspection" },
    ]);
    expect(tokens.has("inspection")).toBe(true);
    expect(tokens.has("inspector")).toBe(true);
    expect(tokens.has("forged")).toBe(true);
    // "quality" is in GENERIC_SKILL_STOPLIST — overlap on it is not evidence of relevance.
    expect(tokens.has("quality")).toBe(false);
  });

  it("counts a shipped skill as a candidate only on an INFORMATIVE shared token", () => {
    const surfaces = SHIPPED.map(surfaceOfShippedSkill);
    expect(candidateShippedSkills(new Set(["fanuc"]), surfaces)).toEqual(["skill_fanuc"]);
    // "operation" appears in shipped "Turning (lathe operation)" and "Fanuc control
    // operation" and is in GENERIC_SKILL_STOPLIST, so it makes nothing a candidate. Without
    // that filter every group with the word in a job title would inherit a denominator it
    // never had.
    expect(candidateShippedSkills(new Set(["operation"]), surfaces)).toEqual([]);
  });
});

// ===========================================================================
// The default path — the REAL shipped corpus
// ===========================================================================

describe("analyzeReuse — against the shipped SKILL_CORPUS", () => {
  it("defaults to the real, non-deprecated shipped vocabulary", () => {
    const analysis = analyzeReuse([skill()], [edge()], { domains: DOMAINS, problems: [] });
    expect(analysis.shipped_skill_count).toBe(shippedSkillViews().length);
    expect(analysis.shipped_skill_count).toBeGreaterThan(0);
  });

  it("catches a real missed reuse of a shipped skill", () => {
    // `skill_tool_offset_setting` ships with the label "Tool offset setting". A model that
    // proposes it under a fresh id is minting a second row for a concept that already has
    // one — the id differs, so no validator check fires, and only this analyzer sees it.
    const analysis = analyzeReuse(
      [
        skill({
          skill_id: "skill_tool_offset_set",
          label_en: "Tool Offset Setting",
          aliases: [{ text: "tool offset set", lang: "en" }],
        }),
      ],
      [edge({ skill_id: "skill_tool_offset_set" })],
      { domains: DOMAINS, problems: [] },
    );
    const d = decisionFor(analysis, "skill_tool_offset_set");
    expect(d.category).toBe("MISSED_REUSE");
    expect(d.matched_existing_skill_id).toBe("skill_tool_offset_setting");
  });
});

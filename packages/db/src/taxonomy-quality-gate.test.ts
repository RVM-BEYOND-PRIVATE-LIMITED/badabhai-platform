/**
 * THE QUALITY GATE — proving that a semantically unsound candidate set CANNOT be persisted,
 * even when every structural check passes.
 *
 * WHAT THESE TESTS ARE ACTUALLY FOR. It is easy to write a gate that reports beautifully and
 * blocks nothing, and impossible to tell the two apart from a passing run. So every blocking
 * code below is pinned from both ends: a corpus that must BLOCK, and the superficially
 * similar corpus that must PASS. The second half is the one that decides whether the gate can
 * survive contact with real output — a gate that blocks on questions rather than on defects
 * gets an operator into the habit of overriding it, and an habitually-overridden gate is
 * worth less than none.
 *
 * The three properties that would silently gut this gate, each pinned by name:
 *
 *   1. ATTRIBUTION. The ingest holds a batch accountable only for what it proposed; the seed
 *      holds everything accountable. Collapse those and either every batch is blocked by
 *      somebody else's committed mistake, or nothing is ever blocked at all.
 *   2. THE PROBE GROUPS ARE REAL. A convergence assertion naming a domain that does not exist
 *      does not fail — it reports ABSENT, which is advisory. So the group ids are checked
 *      against the actual committed corpus, not against the design brief they came from.
 *   3. ONE COPY OF THE ANALYSIS. The ingest must reach the detectors THROUGH this module. A
 *      source-level pin enforces it, because a second copy in the ingest path would drift
 *      from the one these tests exercise.
 *
 * NO REAL TAXONOMY DATA IS CREATED HERE. Every record is a synthetic fixture that exists to
 * make a detector fire.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadTaxonomyCorpus,
  skillLocator,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";
import { type ShippedSkillView } from "./taxonomy-lexical";
import {
  BLOCKING_CODES,
  QUALITY_GATE_CODES,
  TAXONOMY_CONVERGENCE_GROUPS,
  analyzeTaxonomyQuality,
  formatTaxonomyQualityReport,
  isBlockingCode,
  taxonomyQualityVerdict,
  type AnalyzeTaxonomyQualityOptions,
  type QualityGateCode,
} from "./taxonomy-quality-gate";
import { type ConvergenceGroup } from "./taxonomy-convergence";

// ===========================================================================
// Fixtures
// ===========================================================================

const CNC_TURNING = "jd_nco_7223_6002";
const CNC_PROGRAMMER = "jd_nco_7223_6003";
const ASSISTANT_MASON = "jd_nco_7112_0601";
const WAREHOUSE_PICKER = "jd_nco_4321_0601";

const DOMAINS: TaxonomyDomainRecord[] = [
  { job_domain_id: CNC_TURNING, label_en: "CNC Operator-Turning", trade_group: "cnc_machining" },
  { job_domain_id: CNC_PROGRAMMER, label_en: "CNC Programmer", trade_group: "cnc_machining" },
  { job_domain_id: ASSISTANT_MASON, label_en: "Assistant Mason", trade_group: "construction" },
  {
    job_domain_id: WAREHOUSE_PICKER,
    label_en: "Warehouse Picker",
    trade_group: "warehouse_logistics",
  },
];

/** Injected rather than read from `SKILL_CORPUS`, so a test cannot fail because the shipped
 *  vocabulary changed this month. The real corpus gets its own test at the bottom. */
const SHIPPED: ShippedSkillView[] = [
  {
    skill_id: "skill_fanuc",
    label_en: "Fanuc control operation",
    aliases: ["Fanuc", "Fanuc controller"],
  },
  {
    skill_id: "skill_turning",
    label_en: "Turning (lathe operation)",
    aliases: ["turning", "CNC turning"],
  },
];

/** The CNC probe group, scoped to the two domains this file's fixtures use. */
const CNC_GROUP: ConvergenceGroup = {
  group: "cnc_machining",
  job_domain_ids: [CNC_TURNING, CNC_PROGRAMMER],
  concepts: [{ concept: "Fanuc control", probes: ["fanuc"] }],
};

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

/**
 * Analyse + judge in one call.
 *
 * `groups` defaults to the SCOPED CNC group, not to the production set: the production groups
 * name 13 domains, and a fixture carrying four of them would trip
 * CONVERGENCE_GROUP_UNKNOWN_DOMAIN in every unrelated test. The production set is verified
 * against the real corpus in its own describe block, which is where that belongs.
 */
function gate(
  skills: readonly TaxonomySkillRecord[],
  edges: readonly TaxonomyDomainSkillRecord[],
  overrides: Partial<AnalyzeTaxonomyQualityOptions> = {},
) {
  const findings = analyzeTaxonomyQuality(skills, edges, {
    domains: DOMAINS,
    shipped: SHIPPED,
    groups: [CNC_GROUP],
    ...overrides,
  });
  return { findings, ...taxonomyQualityVerdict(findings) };
}

function codesOf(findings: { code: QualityGateCode }[]): QualityGateCode[] {
  return [...new Set(findings.map((f) => f.code))].sort();
}

// ===========================================================================
// The policy itself
// ===========================================================================

describe("the blocking policy is data, and every code is accounted for", () => {
  it("blocks exactly the six permanent-damage codes", () => {
    // Pinned by VALUE, not by "whatever the array says". Adding a code to BLOCKING_CODES is a
    // decision about what refuses to seed, and it should not be possible to make it by
    // accident in a refactor.
    expect([...BLOCKING_CODES].sort()).toEqual([
      "CONVERGENCE_FRAGMENTED",
      "CONVERGENCE_GROUP_UNKNOWN_DOMAIN",
      "FALSE_REUSE",
      "MISSED_REUSE_CATALOGUE",
      "MISSED_REUSE_WITHIN_BATCH",
      "SENIORITY_AS_SKILL",
    ]);
  });

  it("never blocks on a question — the three advisory codes stay advisory", () => {
    for (const code of [
      "POTENTIAL_AMBIGUITY",
      "CONVERGENCE_NEEDS_REVIEW",
      "CONVERGENCE_ABSENT",
      "EDGE_SKILL_UNRESOLVED",
    ] as QualityGateCode[]) {
      expect(isBlockingCode(code), `${code} must not block`).toBe(false);
    }
  });

  it("totals are exhaustive — every code present even at zero", () => {
    const { findings } = gate([], []);
    expect(Object.keys(findings.totals).sort()).toEqual([...QUALITY_GATE_CODES].sort());
  });

  it("reports NO global reuse_rate, at any depth", () => {
    // The five-category breakdown is the deliverable. A single blended percentage would read
    // as "the generator reused 23% of the time" when the truth is "two trade groups had
    // nothing to reuse", and the blended number is the one that gets quoted.
    const { findings } = gate([skill()], [edge()]);
    expect(JSON.stringify(findings)).not.toMatch(/reuse_rate/);
  });
});

// ===========================================================================
// Category 4 — the duplicate that hides
// ===========================================================================

describe("within-batch duplicates BLOCK", () => {
  // The pair that proved the gap: neither is shipped, so no against-catalogue check can see
  // them, and both would otherwise be classified CORRECT_NEW and seeded as two rows.
  const A = skill({
    skill_id: "skill_hydraulic_hose_crimping",
    label_en: "Hydraulic Hose Crimping",
    aliases: [{ text: "hose crimping", lang: "en" }],
  });
  const B = skill({
    skill_id: "skill_crimping_hydraulic_hose",
    label_en: "Crimping Hydraulic Hose",
    aliases: [{ text: "hydraulic crimping", lang: "en" }],
  });
  const EDGES = [
    edge({ skill_id: A.skill_id, job_domain_id: CNC_TURNING }),
    edge({ skill_id: B.skill_id, job_domain_id: CNC_PROGRAMMER }),
  ];

  it("BLOCKS a set whose members are individually well-formed", () => {
    const result = gate([A, B], EDGES, {
      // Nothing structurally wrong: an EMPTY validator problem list, injected, so this test
      // cannot pass because some unrelated structural rule happened to fire.
      problems: [],
    });
    expect(result.verdict).toBe("BLOCK");
    expect(codesOf(result.blocking)).toContain("MISSED_REUSE_WITHIN_BATCH");
  });

  it("names BOTH members, so the reviewer picks the survivor rather than the gate", () => {
    const result = gate([A, B], EDGES, { problems: [] });
    const subjects = result.blocking
      .filter((f) => f.code === "MISSED_REUSE_WITHIN_BATCH")
      .map((f) => f.subject)
      .sort();
    expect(subjects).toEqual([B.skill_id, A.skill_id].sort());
  });

  it("carries WITHIN_BATCH evidence — a reviewer must not be sent chasing a shipped id", () => {
    const result = gate([A, B], EDGES, { problems: [] });
    const finding = result.blocking.find((f) => f.code === "MISSED_REUSE_WITHIN_BATCH");
    expect(finding?.evidence.some((e) => e.startsWith("WITHIN_BATCH:"))).toBe(true);
  });

  it("does NOT block two genuinely distinct skills in the same batch", () => {
    // THE OTHER DIRECTION. Gas torch flame setting and machine program setting are two things
    // a shop floor hires on separately; a gate that merged them would be destroying the
    // taxonomy it audits.
    const gas = skill({
      skill_id: "skill_gas_torch_flame_setting",
      label_en: "Gas Torch Flame Setting",
      aliases: [{ text: "torch flame setting", lang: "en" }],
    });
    const machine = skill({
      skill_id: "skill_weld_program_parameter_setting",
      label_en: "Welding Machine Program Parameter Setting",
      aliases: [{ text: "program parameter setting", lang: "en" }],
    });
    const result = gate(
      [gas, machine],
      [
        edge({ skill_id: gas.skill_id, job_domain_id: CNC_TURNING }),
        edge({ skill_id: machine.skill_id, job_domain_id: CNC_PROGRAMMER }),
      ],
      { problems: [] },
    );
    expect(result.verdict).toBe("PASS");
  });
});

describe("catalogue duplicates BLOCK, and are distinguished from within-batch ones", () => {
  it("BLOCKS a new skill that duplicates a SHIPPED one, under the CATALOGUE code", () => {
    const dupe = skill({
      skill_id: "skill_fanuc_control_operation",
      label_en: "Fanuc control operation",
      aliases: [{ text: "fanuc", lang: "en" }],
    });
    const result = gate([dupe], [edge({ skill_id: dupe.skill_id })], { problems: [] });
    expect(result.verdict).toBe("BLOCK");
    const finding = result.blocking.find((f) => f.code === "MISSED_REUSE_CATALOGUE");
    // The code is decided STRUCTURALLY — the matched id is in the shipped set — not by
    // reading the evidence prefix of another module.
    expect(finding?.skill_ids).toContain("skill_fanuc");
  });

  it("does NOT block a new skill that merely shares vocabulary with a shipped one", () => {
    const distinct = skill({
      skill_id: "skill_fanuc_macro_b_programming",
      label_en: "Fanuc Macro B custom cycle programming",
      aliases: [{ text: "macro b", lang: "en" }],
    });
    const result = gate([distinct], [edge({ skill_id: distinct.skill_id })], { problems: [] });
    expect(result.verdict).toBe("PASS");
  });
});

// ===========================================================================
// Category 3 — false reuse
// ===========================================================================

describe("false reuse BLOCKS, and the validator's own verdict is CONSUMED", () => {
  it("BLOCKS on an injected ALIAS_AMBIGUOUS, proving problems are consumed not recomputed", () => {
    // If the gate recomputed its own notion of "two skills fight over one alias", this
    // hand-written problem string would be ignored and the test would report PASS. It is the
    // only way to prove consumption from the outside.
    const s = skill();
    const injected = `${skillLocator(s.skill_id)}: ALIAS_AMBIGUOUS — "turret index" is already an alias of skill_other.`;
    const result = gate([s], [edge()], { problems: [injected] });
    expect(result.verdict).toBe("BLOCK");
    const finding = result.blocking.find((f) => f.code === "FALSE_REUSE");
    expect(finding?.evidence.some((e) => e.startsWith("VALIDATOR:ALIAS_AMBIGUOUS"))).toBe(true);
  });

  it("PASSES the same skill when the validator reported nothing", () => {
    expect(gate([skill()], [edge()], { problems: [] }).verdict).toBe("PASS");
  });
});

// ===========================================================================
// Convergence
// ===========================================================================

describe("convergence: FRAGMENTED blocks, everything softer does not", () => {
  it("BLOCKS when two equivalent skills carry one concept across related domains", () => {
    const a = skill({
      skill_id: "skill_fanuc_control_operation",
      label_en: "Fanuc Control Operation",
      aliases: [{ text: "fanuc", lang: "en" }],
    });
    const b = skill({
      skill_id: "skill_fanuc_control",
      label_en: "Fanuc Control",
      aliases: [{ text: "fanuc controller", lang: "en" }],
    });
    const result = gate(
      [a, b],
      [
        edge({ skill_id: a.skill_id, job_domain_id: CNC_TURNING }),
        edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER }),
      ],
      { problems: [], shipped: [] },
    );
    expect(result.verdict).toBe("BLOCK");
    expect(codesOf(result.blocking)).toContain("CONVERGENCE_FRAGMENTED");
    const finding = result.blocking.find((f) => f.code === "CONVERGENCE_FRAGMENTED");
    expect(finding?.skill_ids.sort()).toEqual([b.skill_id, a.skill_id].sort());
  });

  it("PASSES when one canonical skill carries the concept across both domains", () => {
    const one = skill({
      skill_id: "skill_fanuc_control_operation",
      label_en: "Fanuc Control Operation",
      aliases: [{ text: "fanuc", lang: "en" }],
    });
    const result = gate(
      [one],
      [
        edge({ skill_id: one.skill_id, job_domain_id: CNC_TURNING }),
        edge({ skill_id: one.skill_id, job_domain_id: CNC_PROGRAMMER }),
      ],
      { problems: [], shipped: [] },
    );
    expect(result.verdict).toBe("PASS");
  });

  it("ABSENT is advisory — a domain that emitted nothing has fragmented nothing", () => {
    const result = gate([skill()], [edge()], { problems: [] });
    expect(result.verdict).toBe("PASS");
    expect(codesOf(result.advisory)).toContain("CONVERGENCE_ABSENT");
  });

  it("NEEDS_REVIEW is advisory — the machine cannot tell a synonym from a specialisation", () => {
    // Two skills answer the "fanuc" probe with no evidence of equivalence. Most likely
    // genuinely distinct, which is allowed.
    const a = skill({
      skill_id: "skill_fanuc_macro_b",
      label_en: "Fanuc Macro B programming",
      aliases: [{ text: "fanuc macro", lang: "en" }],
    });
    const b = skill({
      skill_id: "skill_fanuc_probe_cycle_calibration",
      label_en: "Fanuc renishaw probe cycle calibration",
      aliases: [{ text: "fanuc probing", lang: "en" }],
    });
    const result = gate(
      [a, b],
      [
        edge({ skill_id: a.skill_id, job_domain_id: CNC_TURNING }),
        edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER }),
      ],
      { problems: [], shipped: [] },
    );
    expect(result.verdict).toBe("PASS");
    expect(codesOf(result.advisory)).toContain("CONVERGENCE_NEEDS_REVIEW");
  });
});

// ===========================================================================
// Seniority
// ===========================================================================

describe("a seniority rung wearing a skill's clothes BLOCKS", () => {
  it("BLOCKS 'Assistant Masonry' on the Assistant Mason domain", () => {
    const s = skill({
      skill_id: "skill_assistant_masonry",
      label_en: "Assistant Masonry",
      aliases: [{ text: "mason helper", lang: "en" }],
    });
    const result = gate([s], [edge({ skill_id: s.skill_id, job_domain_id: ASSISTANT_MASON })], {
      problems: [],
    });
    expect(result.verdict).toBe("BLOCK");
    expect(codesOf(result.blocking)).toContain("SENIORITY_AS_SKILL");
  });

  it("does NOT block a real capability that merely carries a level word", () => {
    // "Supervisor level scaffold inspection" keeps `scaffold`. Condemning it for the
    // adjective in front would delete a genuine skill.
    const s = skill({
      skill_id: "skill_supervisor_scaffold_inspection",
      label_en: "Supervisor level scaffold inspection",
      aliases: [{ text: "scaffold inspection", lang: "en" }],
    });
    const result = gate([s], [edge({ skill_id: s.skill_id, job_domain_id: ASSISTANT_MASON })], {
      problems: [],
    });
    expect(result.verdict).toBe("PASS");
  });
});

// ===========================================================================
// Attribution — the ingest posture vs the seed posture
// ===========================================================================

describe("attribution decides WHO a finding blocks", () => {
  const OLD = skill({
    skill_id: "skill_hydraulic_hose_crimping",
    label_en: "Hydraulic Hose Crimping",
    aliases: [{ text: "hose crimping", lang: "en" }],
  });
  const NEW = skill({
    skill_id: "skill_crimping_hydraulic_hose",
    label_en: "Crimping Hydraulic Hose",
    aliases: [{ text: "hydraulic crimping", lang: "en" }],
  });
  const EDGES = [
    edge({ skill_id: OLD.skill_id, job_domain_id: CNC_TURNING }),
    edge({ skill_id: NEW.skill_id, job_domain_id: CNC_PROGRAMMER }),
  ];

  it("INGEST: a duplicate pair the batch did not create does not block it", () => {
    // Both members are committed; this batch proposed something else entirely. Blaming it
    // would block every future batch until someone fixes a corpus they did not touch.
    const result = gate([OLD, NEW], EDGES, {
      problems: [],
      attributableSkillIds: ["skill_something_unrelated"],
    });
    expect(result.verdict).toBe("PASS");
  });

  it("INGEST: the same pair is still REPORTED, as a pre-existing blocking-class finding", () => {
    // Not blocked is not the same as not shown. Silence here would let a corpus rot one
    // un-blamed batch at a time.
    const result = gate([OLD, NEW], EDGES, {
      problems: [],
      attributableSkillIds: ["skill_something_unrelated"],
    });
    const preExisting = result.advisory.filter((f) => isBlockingCode(f.code));
    expect(codesOf(preExisting)).toContain("MISSED_REUSE_WITHIN_BATCH");
  });

  it("INGEST: a NEW member of a duplicate pair DOES block, even when its twin is committed", () => {
    const result = gate([OLD, NEW], EDGES, {
      problems: [],
      attributableSkillIds: [NEW.skill_id],
    });
    expect(result.verdict).toBe("BLOCK");
    // BOTH ends block, and that is the intended reading: attribution is per FINDING, and each
    // finding implicates the whole pair. The committed twin is not being blamed for existing —
    // it is named because the reviewer has to choose which of the two rows survives, and a
    // gate that showed only the new half would be asking them to fix a pair it only half
    // described. What attribution actually buys is the case below: a pair with NEITHER member
    // in scope does not block, so a batch is never held hostage by a corpus it did not touch.
    expect(result.blocking.map((f) => f.subject).sort()).toEqual(
      [NEW.skill_id, OLD.skill_id].sort(),
    );
  });

  it("SEED: omitting the scope holds EVERYTHING accountable, so the same pair blocks", () => {
    const result = gate([OLD, NEW], EDGES, { problems: [] });
    expect(result.verdict).toBe("BLOCK");
    expect(result.blocking.map((f) => f.subject).sort()).toEqual(
      [NEW.skill_id, OLD.skill_id].sort(),
    );
  });

  it("an EMPTY scope means 'accountable for nothing', never 'accountable for everything'", () => {
    // The classic version of this bug: `ids?.length ? ids : undefined`, which turns a batch
    // that accepted zero candidates into a run that blames the whole corpus. `undefined` and
    // `[]` must stay distinguishable.
    expect(gate([OLD, NEW], EDGES, { problems: [], attributableSkillIds: [] }).verdict).toBe(
      "PASS",
    );
    expect(gate([OLD, NEW], EDGES, { problems: [] }).verdict).toBe("BLOCK");
  });

  it("records the scope it used, so a report cannot be misread as the other posture", () => {
    expect(gate([], [], { problems: [] }).findings.attributable_skill_ids).toBeNull();
    expect(
      gate([], [], { problems: [], attributableSkillIds: ["b", "a", "a"] }).findings
        .attributable_skill_ids,
    ).toEqual(["a", "b"]);
  });
});

// ===========================================================================
// Probe-group integrity
// ===========================================================================

describe("a convergence assertion cannot be vacuous", () => {
  it("BLOCKS when a probe group names a domain the corpus does not contain", () => {
    const stale: ConvergenceGroup = {
      group: "cnc_machining",
      job_domain_ids: [CNC_TURNING, "jd_nco_9999_0000"],
      concepts: [{ concept: "Fanuc control", probes: ["fanuc"] }],
    };
    const result = gate([skill()], [edge()], { problems: [], groups: [stale] });
    expect(result.verdict).toBe("BLOCK");
    const finding = result.blocking.find((f) => f.code === "CONVERGENCE_GROUP_UNKNOWN_DOMAIN");
    expect(finding?.evidence).toEqual(["CONFIG:unknown_domain jd_nco_9999_0000"]);
  });

  it("blocks regardless of scope — a broken assertion is nobody's batch's fault to escape", () => {
    const stale: ConvergenceGroup = {
      group: "x",
      job_domain_ids: ["jd_nco_9999_0000"],
      concepts: [{ concept: "c", probes: ["p"] }],
    };
    const result = gate([skill()], [edge()], {
      problems: [],
      groups: [stale],
      attributableSkillIds: [],
    });
    expect(result.verdict).toBe("BLOCK");
  });
});

describe("the production probe groups are built from VERIFIED corpus entities", () => {
  const corpus = loadTaxonomyCorpus();
  const known = new Set(corpus.domains.map((d) => d.job_domain_id));

  it("every declared domain id exists in the committed corpus", () => {
    // The requirement in one assertion: assertions are derived from verified corpus
    // entities, never from assumptions in a design brief. If sample-domains.jsonl loses a
    // row, this fails here rather than degrading silently to ABSENT at ingest time.
    const missing = TAXONOMY_CONVERGENCE_GROUPS.flatMap((g) =>
      g.job_domain_ids.filter((id) => !known.has(id)),
    );
    expect(missing).toEqual([]);
  });

  it("covers the five groups the phase requires, warehouse included as the control", () => {
    expect(TAXONOMY_CONVERGENCE_GROUPS.map((g) => g.group).sort()).toEqual([
      "cnc_machining",
      "construction",
      "quality_inspection",
      "warehouse_logistics",
      "welding",
    ]);
  });

  it("carries no over-broad probe smuggled in from a test fixture", () => {
    // The unit tests carry a deliberately over-broad `"setting"` probe to prove the detector
    // reports NEEDS_REVIEW rather than inventing a fragmentation. A probe chosen to
    // demonstrate a failure mode must never run in production.
    const probes = TAXONOMY_CONVERGENCE_GROUPS.flatMap((g) => g.concepts.flatMap((c) => c.probes));
    expect(probes).not.toContain("setting");
    for (const p of probes) expect(p.trim().length).toBeGreaterThan(3);
  });

  it("groups by DOMAIN ID and never by trade_group", () => {
    // `trade_group -> same skill` is the forbidden inference: it would force a genuinely
    // distinct skill in a related trade to merge. Structural, not a promise — the field is
    // not part of ConvergenceGroup, and this pins that it was not smuggled back in.
    for (const g of TAXONOMY_CONVERGENCE_GROUPS) {
      expect(Object.keys(g).sort()).toEqual(["concepts", "group", "job_domain_ids"]);
      for (const id of g.job_domain_ids) expect(id).toMatch(/^jd_/);
    }
  });
});

// ===========================================================================
// The warehouse control
// ===========================================================================

describe("warehouse — low shipped coverage is REPORTED, never punished", () => {
  it("reports a NULL ratio, not a zero, and does not block", () => {
    const s = skill({
      skill_id: "skill_stock_counting",
      label_en: "Stock Counting",
      aliases: [{ text: "stock count", lang: "en" }],
    });
    const result = gate([s], [edge({ skill_id: s.skill_id, job_domain_id: WAREHOUSE_PICKER })], {
      problems: [],
    });
    const warehouse = result.findings.reuse.by_trade_group.find(
      (g) => g.trade_group === "warehouse_logistics",
    );
    // Zero would read as "the generator failed to reuse anything". NULL reads as "there was
    // nothing to reuse", which is the truth for every trade the CNC wedge does not cover.
    expect(warehouse?.reuse_opportunity_ratio).toBeNull();
    expect(warehouse?.limitation).toBe("no_shipped_coverage");
    expect(result.verdict).toBe("PASS");
  });

  it("says so in the rendered report, in words a column-scanner cannot get backwards", () => {
    const s = skill({ skill_id: "skill_stock_counting", label_en: "Stock Counting" });
    const result = gate([s], [edge({ skill_id: s.skill_id, job_domain_id: WAREHOUSE_PICKER })], {
      problems: [],
    });
    const rendered = formatTaxonomyQualityReport(result.findings, result).join("\n");
    expect(rendered).toMatch(/NULL ratio = nothing was available to reuse/);
    expect(rendered).toMatch(/warehouse_logistics.*ratio=NULL.*no_shipped_coverage/);
  });
});

// ===========================================================================
// Determinism + the one-copy pin
// ===========================================================================

describe("structural guarantees", () => {
  it("is PURE — the same inputs produce byte-identical findings", () => {
    const s = [skill(), skill({ skill_id: "skill_b", label_en: "Coolant Management" })];
    const e = [edge(), edge({ skill_id: "skill_b", job_domain_id: CNC_PROGRAMMER })];
    expect(JSON.stringify(gate(s, e, { problems: [] }).findings)).toBe(
      JSON.stringify(gate(s, e, { problems: [] }).findings),
    );
  });

  it("the ingest and the seed reach the detectors THROUGH this gate, not around it", () => {
    // A second copy of the analysis in the ingest path would drift from the one these tests
    // exercise, and the copy that drifts is the one that ships. The only import either
    // persistence path may have is the gate itself.
    for (const file of ["generate-domain-skills.ts", "seed-domain-skills.ts"]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      for (const forbidden of [
        "./taxonomy-reuse-analysis",
        "./taxonomy-convergence",
        "./taxonomy-lexical",
      ]) {
        expect(source, `${file} must not import ${forbidden} directly`).not.toContain(
          `from "${forbidden}"`,
        );
      }
      expect(source).toContain(`from "./taxonomy-quality-gate"`);
    }
  });

  it("the seed refuses on BLOCK — the refusal is in the source, before any connection", () => {
    // The seeder's gate cannot be unit-tested end to end without a database, but the ORDER
    // is what matters and the order is decidable here: the quality gate must appear before
    // `createDbClient`, or an invalid corpus would open a transaction before being refused.
    const source = readFileSync(join(__dirname, "seed-domain-skills.ts"), "utf8");
    const gateAt = source.indexOf("taxonomyQualityVerdict(qualityFindings)");
    const connectAt = source.indexOf("createDbClient(");
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(connectAt);
    expect(source).toMatch(/quality gate BLOCKED — refusing to seed/);
  });
});

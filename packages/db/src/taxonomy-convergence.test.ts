/**
 * `detectConvergence` + `detectSeniorityLabels` — proving the detectors work, before there
 * is any generated data to point them at.
 *
 * WHAT THESE TESTS ARE FOR. A convergence detector that has only ever seen well-formed input
 * is indistinguishable from `return "CONVERGED"`. So EVERY group below is pinned twice: once
 * with a fixture where the domains agreed on one canonical skill (the detector must say
 * CONVERGED) and once with a fixture where they minted near-duplicates (the detector must say
 * FRAGMENTED, and must name every id in the cluster).
 *
 * AND THE OTHER DIRECTION, WHICH MATTERS MORE. This detector can do real damage if it is
 * wrong in the permissive direction — a FRAGMENTED verdict on two genuinely different skills
 * is an instruction to merge them, and merging "gas torch flame setting" into "welding
 * machine program setting" would put a machine-programming skill on a gas welder's picker
 * forever. So the welding group pins BOTH: the shared core converges, the genuinely distinct
 * pair stays separate, and a deliberately over-broad probe that catches both reports
 * NEEDS_REVIEW rather than fragmentation.
 *
 *   EXPECTED:  semantic equivalence  ->  convergence
 *   FORBIDDEN: same trade group      ->  same skill
 *
 * The domain ids are the REAL ones from `data/taxonomy/sample-domains.jsonl` so the fixtures
 * read like the corpus they will one day be run against. Everything else here is synthetic
 * and exists only to make a detector fire. NO REAL TAXONOMY DATA IS CREATED BY THIS FILE.
 */
import { describe, expect, it } from "vitest";

import {
  MIN_DOMAIN_STEM_MATCH,
  SENIORITY_WORDS,
  classifySeniorityLabel,
  detectConvergence,
  detectSeniorityLabels,
  type ConvergenceFinding,
  type ConvergenceGroup,
} from "./taxonomy-convergence";
import type {
  TaxonomyDomainRecord,
  TaxonomyDomainSkillRecord,
  TaxonomySkillRecord,
} from "./taxonomy-corpus";
import type { ShippedSkillView } from "./taxonomy-lexical";

// ===========================================================================
// Fixture builders
// ===========================================================================

/** A skill record. Aliases default to the label itself — the minimum the validator accepts. */
function s(id: string, label: string, aliases: string[] = [label]): TaxonomySkillRecord {
  return {
    kind: "skill",
    skill_id: id,
    label_en: label,
    label_hi: null,
    aliases: aliases.map((text) => ({ text, lang: "en" as const })),
  };
}

/** An edge. Requirement/relevance are irrelevant to convergence and are held constant. */
function e(jobDomainId: string, skillId: string): TaxonomyDomainSkillRecord {
  return {
    kind: "domain_skill",
    job_domain_id: jobDomainId,
    skill_id: skillId,
    default_requirement: "required",
    relevance: 80,
    confidence: 0.8,
    source: "llm_bootstrap",
  };
}

/** No shipped vocabulary unless a fixture needs one — keeps the assertions about the fixture. */
const NO_SHIPPED: ShippedSkillView[] = [];

function findingFor(findings: ConvergenceFinding[], concept: string): ConvergenceFinding {
  const found = findings.find((f) => f.concept === concept);
  expect(found, `no finding for concept ${concept}`).toBeDefined();
  return found as ConvergenceFinding;
}

// ===========================================================================
// CNC — jd_nco_7223_6002 / 6003 / 0701
// ===========================================================================

const CNC_TURNING = "jd_nco_7223_6002";
const CNC_PROGRAMMER = "jd_nco_7223_6003";
const LATHE_MACHINIST = "jd_nco_7223_0701";

const CNC_GROUP: ConvergenceGroup = {
  group: "cnc_machining",
  job_domain_ids: [CNC_TURNING, CNC_PROGRAMMER, LATHE_MACHINIST],
  concepts: [
    { concept: "Fanuc CNC", probes: ["fanuc"] },
    { concept: "G-Code", probes: ["g-code", "g code", "gcode"] },
  ],
};

describe("detectConvergence — CNC controls and G-code", () => {
  it("CONVERGED: three domains, one canonical Fanuc skill and one canonical G-code skill", () => {
    const skills = [
      s("skill_fanuc_control_operation", "Fanuc Control Operation", ["fanuc", "fanuc controller"]),
      s("skill_g_code_programming", "G-Code Programming", ["g code", "gcode"]),
    ];
    const edges = CNC_GROUP.job_domain_ids.flatMap((d) => [
      e(d, "skill_fanuc_control_operation"),
      e(d, "skill_g_code_programming"),
    ]);
    const { findings, totals } = detectConvergence(skills, edges, [CNC_GROUP], { shipped: NO_SHIPPED });

    const fanuc = findingFor(findings, "Fanuc CNC");
    expect(fanuc.status).toBe("CONVERGED");
    expect(fanuc.skill_ids).toEqual(["skill_fanuc_control_operation"]);
    expect(fanuc.domains_with_concept).toEqual([...CNC_GROUP.job_domain_ids].sort());
    expect(fanuc.domains_without_concept).toEqual([]);
    expect(findingFor(findings, "G-Code").status).toBe("CONVERGED");
    expect(totals.FRAGMENTED).toBe(0);
  });

  it("FRAGMENTED: the exact three-way Fanuc split from the brief is named in full", () => {
    // skill_fanuc_cnc / skill_fanuc_cnc_control / skill_fanuc_controller. The first two are a
    // bounded token-subset of each other; the third shares the alias "fanuc". All three are
    // one concept wearing three immutable ids, and once seeded that split is permanent.
    const skills = [
      s("skill_fanuc_cnc", "Fanuc CNC", ["fanuc"]),
      s("skill_fanuc_cnc_control", "Fanuc CNC Control", ["fanuc cnc control"]),
      s("skill_fanuc_controller", "Fanuc Controller", ["fanuc"]),
    ];
    const edges = [
      e(CNC_TURNING, "skill_fanuc_cnc"),
      e(CNC_PROGRAMMER, "skill_fanuc_cnc_control"),
      e(LATHE_MACHINIST, "skill_fanuc_controller"),
    ];
    const finding = findingFor(
      detectConvergence(skills, edges, [CNC_GROUP], { shipped: NO_SHIPPED }).findings,
      "Fanuc CNC",
    );
    expect(finding.status).toBe("FRAGMENTED");
    expect(finding.fragmented_clusters).toEqual([
      ["skill_fanuc_cnc", "skill_fanuc_cnc_control", "skill_fanuc_controller"],
    ]);
    expect(finding.evidence.some((x) => x.startsWith("STRONG:"))).toBe(true);
  });

  it("FRAGMENTED: two G-code skills that share an alias are a coin flip, not two skills", () => {
    const skills = [
      s("skill_g_code_programming", "G-Code Programming", ["g code"]),
      s("skill_g_code_editing", "G-Code Editing", ["g code"]),
    ];
    const edges = [
      e(CNC_PROGRAMMER, "skill_g_code_programming"),
      e(LATHE_MACHINIST, "skill_g_code_editing"),
    ];
    const finding = findingFor(
      detectConvergence(skills, edges, [CNC_GROUP], { shipped: NO_SHIPPED }).findings,
      "G-Code",
    );
    expect(finding.status).toBe("FRAGMENTED");
    expect(finding.fragmented_clusters).toEqual([["skill_g_code_editing", "skill_g_code_programming"]]);
    expect(finding.evidence.some((x) => x.startsWith("STRONG:surface_form_shared"))).toBe(true);
  });

  it("ABSENT: no domain produced the concept at all", () => {
    const finding = findingFor(
      detectConvergence(
        [s("skill_turret_indexing", "Turret Indexing")],
        [e(CNC_TURNING, "skill_turret_indexing")],
        [CNC_GROUP],
        { shipped: NO_SHIPPED },
      ).findings,
      "Fanuc CNC",
    );
    expect(finding.status).toBe("ABSENT");
    expect(finding.skill_ids).toEqual([]);
  });

  it("a domain that simply did not emit the concept is REPORTED, not penalised", () => {
    // One skill, two of three domains. There is no second row, so there is nothing split —
    // the silent domain is a coverage question for the reviewer, not a convergence failure.
    const skills = [s("skill_fanuc_control_operation", "Fanuc Control Operation", ["fanuc"])];
    const edges = [
      e(CNC_TURNING, "skill_fanuc_control_operation"),
      e(CNC_PROGRAMMER, "skill_fanuc_control_operation"),
    ];
    const finding = findingFor(
      detectConvergence(skills, edges, [CNC_GROUP], { shipped: NO_SHIPPED }).findings,
      "Fanuc CNC",
    );
    expect(finding.status).toBe("CONVERGED");
    expect(finding.domains_without_concept).toEqual([LATHE_MACHINIST]);
  });
});

// ===========================================================================
// WELDING — jd_nco_7212_0301 / 0100 / 0300
// ===========================================================================

const WELDER = "jd_nco_7212_0301";
const WELDER_GAS = "jd_nco_7212_0100";
const WELDER_MACHINE = "jd_nco_7212_0300";

const WELDING_GROUP: ConvergenceGroup = {
  group: "welding",
  job_domain_ids: [WELDER, WELDER_GAS, WELDER_MACHINE],
  concepts: [
    { concept: "Weld bead inspection", probes: ["bead"] },
    { concept: "Torch flame setting", probes: ["torch"] },
    { concept: "Machine program setting", probes: ["program parameter"] },
    // Deliberately over-broad. See the test that consumes it.
    { concept: "Anything called setting", probes: ["setting"] },
  ],
};

describe("detectConvergence — welding: a shared core AND a genuinely distinct pair", () => {
  const SHARED_CORE = s("skill_weld_bead_inspection", "Weld Bead Inspection", ["bead check"]);
  const GAS_ONLY = s("skill_gas_torch_flame_setting", "Gas Torch Flame Setting", ["torch flame setting"]);
  const MACHINE_ONLY = s(
    "skill_weld_program_parameter_setting",
    "Welding Machine Program Parameter Setting",
    ["weld program parameter setting"],
  );

  const converged = {
    skills: [SHARED_CORE, GAS_ONLY, MACHINE_ONLY],
    edges: [
      e(WELDER, "skill_weld_bead_inspection"),
      e(WELDER_GAS, "skill_weld_bead_inspection"),
      e(WELDER_MACHINE, "skill_weld_bead_inspection"),
      e(WELDER_GAS, "skill_gas_torch_flame_setting"),
      e(WELDER_MACHINE, "skill_weld_program_parameter_setting"),
    ],
  };

  it("CONVERGED: the core skill all three domains need lands on one id", () => {
    const { findings } = detectConvergence(converged.skills, converged.edges, [WELDING_GROUP], {
      shipped: NO_SHIPPED,
    });
    const core = findingFor(findings, "Weld bead inspection");
    expect(core.status).toBe("CONVERGED");
    expect(core.skill_ids).toEqual(["skill_weld_bead_inspection"]);
    expect(core.domains_with_concept).toHaveLength(3);
  });

  it("the gas-specific and machine-specific skills are kept SEPARATE and are NOT a problem", () => {
    // The direction that protects the taxonomy. Torch flame setting is a gas skill; program
    // parameter setting is a machine skill. Merging them would put a machine-programming
    // requirement on a gas welder's picker, which is worse than any fragmentation.
    const { findings, totals } = detectConvergence(converged.skills, converged.edges, [WELDING_GROUP], {
      shipped: NO_SHIPPED,
    });
    expect(totals.FRAGMENTED).toBe(0);

    const torch = findingFor(findings, "Torch flame setting");
    expect(torch.status).toBe("CONVERGED");
    expect(torch.skill_ids).toEqual(["skill_gas_torch_flame_setting"]);
    expect(torch.domains_without_concept).toEqual([WELDER, WELDER_MACHINE].sort());

    const program = findingFor(findings, "Machine program setting");
    expect(program.status).toBe("CONVERGED");
    expect(program.skill_ids).toEqual(["skill_weld_program_parameter_setting"]);
  });

  it("an over-broad probe that catches both distinct skills says NEEDS_REVIEW, never FRAGMENTED", () => {
    const finding = findingFor(
      detectConvergence(converged.skills, converged.edges, [WELDING_GROUP], { shipped: NO_SHIPPED })
        .findings,
      "Anything called setting",
    );
    expect(finding.skill_ids).toEqual([
      "skill_gas_torch_flame_setting",
      "skill_weld_program_parameter_setting",
    ]);
    expect(finding.status).toBe("NEEDS_REVIEW");
    expect(finding.fragmented_clusters).toEqual([]);
    expect(finding.reason).toContain("NOT a fragmentation finding");
  });

  it("FRAGMENTED: three near-duplicate bead-inspection skills, one per welding domain", () => {
    const skills = [
      s("skill_weld_bead_inspection", "Weld Bead Inspection", ["bead check"]),
      s("skill_weld_bead_visual_inspection", "Weld Bead Visual Inspection", ["visual bead check"]),
      s("skill_bead_inspection", "Bead Inspection", ["bead inspect"]),
    ];
    const edges = [
      e(WELDER, "skill_weld_bead_inspection"),
      e(WELDER_GAS, "skill_weld_bead_visual_inspection"),
      e(WELDER_MACHINE, "skill_bead_inspection"),
    ];
    const finding = findingFor(
      detectConvergence(skills, edges, [WELDING_GROUP], { shipped: NO_SHIPPED }).findings,
      "Weld bead inspection",
    );
    expect(finding.status).toBe("FRAGMENTED");
    expect(finding.fragmented_clusters).toEqual([
      ["skill_bead_inspection", "skill_weld_bead_inspection", "skill_weld_bead_visual_inspection"],
    ]);
  });
});

// ===========================================================================
// QUALITY — jd_nco_7543_2001 / jd_nco_7313_2601
//
// NOTE: the brief spoke of three separate Forged / Cast / Machined domains. The real corpus
// has ONE combined domain (7543.2001 "Quality Inspector-forged, casted or machined
// components") plus "Final Quality Inspector" (7313.2601). These fixtures use the REAL ids.
// ===========================================================================

const QUALITY_COMBINED = "jd_nco_7543_2001";
const QUALITY_FINAL = "jd_nco_7313_2601";

/** The two shipped machining/metrology skills a quality domain would legitimately reuse. */
const QUALITY_SHIPPED: ShippedSkillView[] = [
  {
    skill_id: "skill_dimensional_inspection",
    label_en: "Dimensional inspection",
    aliases: ["inspection", "dimensional inspection", "quality check"],
  },
  {
    skill_id: "skill_measuring_instruments",
    label_en: "Micrometer / Vernier / gauge usage",
    aliases: ["micrometer", "vernier caliper", "gauge"],
  },
];

const QUALITY_GROUP: ConvergenceGroup = {
  group: "quality_inspection",
  job_domain_ids: [QUALITY_COMBINED, QUALITY_FINAL],
  concepts: [
    { concept: "Dimensional inspection", probes: ["dimensional inspection"] },
    { concept: "Measuring instruments", probes: ["micrometer"] },
  ],
};

describe("detectConvergence — quality inspection reusing shipped machining skills", () => {
  it("CONVERGED: both domains reuse the same shipped skill, with no corpus record at all", () => {
    // A reuse looks like an edge and nothing else — there is no skill record to read. The
    // detector has to resolve the label through the shipped views or it reports ABSENT for
    // every correctly-reused skill in the corpus, which would be exactly backwards.
    const edges = [
      e(QUALITY_COMBINED, "skill_dimensional_inspection"),
      e(QUALITY_FINAL, "skill_dimensional_inspection"),
      e(QUALITY_COMBINED, "skill_measuring_instruments"),
      e(QUALITY_FINAL, "skill_measuring_instruments"),
    ];
    const { findings, totals } = detectConvergence([], edges, [QUALITY_GROUP], {
      shipped: QUALITY_SHIPPED,
    });
    expect(totals.CONVERGED).toBe(2);
    expect(findingFor(findings, "Dimensional inspection").skill_ids).toEqual([
      "skill_dimensional_inspection",
    ]);
    expect(findingFor(findings, "Measuring instruments").domains_with_concept).toHaveLength(2);
  });

  it("FRAGMENTED: one domain reuses the shipped skill, the other mints a synonym of it", () => {
    const skills = [
      s("skill_dimensional_checking", "Dimensional Checking", ["dimensional inspection"]),
    ];
    const edges = [
      e(QUALITY_COMBINED, "skill_dimensional_inspection"),
      e(QUALITY_FINAL, "skill_dimensional_checking"),
    ];
    const finding = findingFor(
      detectConvergence(skills, edges, [QUALITY_GROUP], { shipped: QUALITY_SHIPPED }).findings,
      "Dimensional inspection",
    );
    expect(finding.status).toBe("FRAGMENTED");
    expect(finding.fragmented_clusters).toEqual([
      ["skill_dimensional_checking", "skill_dimensional_inspection"],
    ]);
  });
});

// ===========================================================================
// MASONRY — jd_nco_7112_0100 / 0601
// ===========================================================================

const STONE_MASON = "jd_nco_7112_0100";
const ASSISTANT_MASON = "jd_nco_7112_0601";

const MASONRY_DOMAINS: TaxonomyDomainRecord[] = [
  { job_domain_id: STONE_MASON, label_en: "Stone Mason", trade_group: "construction" },
  { job_domain_id: ASSISTANT_MASON, label_en: "Assistant Mason", trade_group: "construction" },
];

const MASONRY_GROUP: ConvergenceGroup = {
  group: "construction",
  job_domain_ids: [STONE_MASON, ASSISTANT_MASON],
  concepts: [{ concept: "Mortar work", probes: ["mortar"] }],
};

describe("detectConvergence — masonry", () => {
  it("CONVERGED: both mason domains land on one mortar skill", () => {
    const skills = [s("skill_mortar_mixing", "Mortar Mixing", ["mortar mix"])];
    const edges = [e(STONE_MASON, "skill_mortar_mixing"), e(ASSISTANT_MASON, "skill_mortar_mixing")];
    const finding = findingFor(
      detectConvergence(skills, edges, [MASONRY_GROUP], { shipped: NO_SHIPPED }).findings,
      "Mortar work",
    );
    expect(finding.status).toBe("CONVERGED");
    expect(finding.domains_with_concept).toHaveLength(2);
  });

  it("FRAGMENTED: the mason and the assistant mason mint one concept twice", () => {
    const skills = [
      s("skill_mortar_mixing", "Mortar Mixing", ["mortar mix"]),
      s("skill_mortar_preparation", "Mortar Preparation", ["mortar mix"]),
    ];
    const edges = [
      e(STONE_MASON, "skill_mortar_mixing"),
      e(ASSISTANT_MASON, "skill_mortar_preparation"),
    ];
    const finding = findingFor(
      detectConvergence(skills, edges, [MASONRY_GROUP], { shipped: NO_SHIPPED }).findings,
      "Mortar work",
    );
    expect(finding.status).toBe("FRAGMENTED");
    expect(finding.fragmented_clusters).toEqual([["skill_mortar_mixing", "skill_mortar_preparation"]]);
  });
});

// ===========================================================================
// WAREHOUSE — jd_isco_4321 / jd_nco_4321_0100 / jd_nco_4321_0601
// ===========================================================================

const STOCK_CLERKS = "jd_isco_4321";
const STORE_KEEPER = "jd_nco_4321_0100";
const WAREHOUSE_PICKER = "jd_nco_4321_0601";

const WAREHOUSE_GROUP: ConvergenceGroup = {
  group: "warehouse_logistics",
  job_domain_ids: [STOCK_CLERKS, STORE_KEEPER, WAREHOUSE_PICKER],
  concepts: [
    { concept: "Stock counting", probes: ["stock"] },
    { concept: "Material handling", probes: ["handling"] },
  ],
};

describe("detectConvergence — warehouse near-synonyms", () => {
  it("CONVERGED: three warehouse domains agree on one stock-counting skill", () => {
    const skills = [s("skill_stock_counting", "Stock Counting", ["stock count", "stock taking"])];
    const edges = WAREHOUSE_GROUP.job_domain_ids.map((d) => e(d, "skill_stock_counting"));
    const finding = findingFor(
      detectConvergence(skills, edges, [WAREHOUSE_GROUP], { shipped: NO_SHIPPED }).findings,
      "Stock counting",
    );
    expect(finding.status).toBe("CONVERGED");
    expect(finding.domains_without_concept).toEqual([]);
  });

  it("FRAGMENTED: stock counting / stock taking / inventory counting are one concept", () => {
    // The near-synonym case. "Inventory Counting" shares no label token with "Stock Counting"
    // beyond `counting`, but all three answer to "stock count" — so a worker who says it
    // canonicalizes to whichever row wins the coin flip.
    const skills = [
      s("skill_stock_counting", "Stock Counting", ["stock count"]),
      s("skill_stock_taking", "Stock Taking", ["stock count"]),
      s("skill_inventory_counting", "Inventory Counting", ["stock count"]),
    ];
    const edges = [
      e(STOCK_CLERKS, "skill_stock_counting"),
      e(STORE_KEEPER, "skill_stock_taking"),
      e(WAREHOUSE_PICKER, "skill_inventory_counting"),
    ];
    const finding = findingFor(
      detectConvergence(skills, edges, [WAREHOUSE_GROUP], { shipped: NO_SHIPPED }).findings,
      "Stock counting",
    );
    expect(finding.status).toBe("FRAGMENTED");
    expect(finding.fragmented_clusters).toEqual([
      ["skill_inventory_counting", "skill_stock_counting", "skill_stock_taking"],
    ]);
  });

  it("does NOT fragment two distinct skills merely because the domains are related", () => {
    // THE FORBIDDEN INFERENCE. Both skills are emitted by all three domains of one trade
    // group and both answer the same probe. They are still different things, and the detector
    // has no evidence otherwise, so it must ask rather than assert.
    const skills = [
      s("skill_manual_load_handling", "Manual Load Handling", ["load handling"]),
      s("skill_hazardous_material_handling", "Hazardous Material Handling", ["hazmat handling"]),
    ];
    const edges = WAREHOUSE_GROUP.job_domain_ids.flatMap((d) => [
      e(d, "skill_manual_load_handling"),
      e(d, "skill_hazardous_material_handling"),
    ]);
    const report = detectConvergence(skills, edges, [WAREHOUSE_GROUP], { shipped: NO_SHIPPED });
    const finding = findingFor(report.findings, "Material handling");
    expect(finding.status).toBe("NEEDS_REVIEW");
    expect(finding.fragmented_clusters).toEqual([]);
    // And the reason can never be "they are in the same trade group" — the detector is not
    // given trade groups at all. `ConvergenceGroup` names DOMAIN IDS by construction.
    expect(JSON.stringify(report)).not.toContain("trade_group");
  });
});

// ===========================================================================
// Report contract
// ===========================================================================

describe("detectConvergence — the report contract", () => {
  it("totals every finding into exactly one status", () => {
    const skills = [s("skill_stock_counting", "Stock Counting", ["stock count"])];
    const edges = [e(STOCK_CLERKS, "skill_stock_counting")];
    const report = detectConvergence(skills, edges, [WAREHOUSE_GROUP, CNC_GROUP], {
      shipped: NO_SHIPPED,
    });
    expect(report.findings).toHaveLength(
      WAREHOUSE_GROUP.concepts.length + CNC_GROUP.concepts.length,
    );
    expect(Object.values(report.totals).reduce((a, b) => a + b, 0)).toBe(report.findings.length);
  });

  it("ignores an edge to a skill it cannot resolve rather than inventing a finding", () => {
    const report = detectConvergence([], [e(CNC_TURNING, "skill_never_declared")], [CNC_GROUP], {
      shipped: NO_SHIPPED,
    });
    expect(report.totals.ABSENT).toBe(CNC_GROUP.concepts.length);
  });

  it("is pure — the same inputs produce a deep-equal report", () => {
    const skills = [s("skill_fanuc_cnc", "Fanuc CNC", ["fanuc"])];
    const edges = [e(CNC_TURNING, "skill_fanuc_cnc")];
    expect(detectConvergence(skills, edges, [CNC_GROUP], { shipped: NO_SHIPPED })).toEqual(
      detectConvergence(skills, edges, [CNC_GROUP], { shipped: NO_SHIPPED }),
    );
  });
});

// ===========================================================================
// The seniority detector
// ===========================================================================

describe("detectSeniorityLabels — a rung on a ladder is not a skill", () => {
  const edges = [
    e(ASSISTANT_MASON, "skill_assistant_masonry"),
    e(ASSISTANT_MASON, "skill_helper_work"),
    e(ASSISTANT_MASON, "skill_sahayak"),
    e(ASSISTANT_MASON, "skill_mortar_mixing"),
    e(STONE_MASON, "skill_mortar_mixing"),
    e(ASSISTANT_MASON, "skill_supervisor_scaffold_inspection"),
  ];
  const skills = [
    s("skill_assistant_masonry", "Assistant Masonry", ["assistant masonry"]),
    s("skill_helper_work", "Helper Work", ["helper work"]),
    s("skill_sahayak", "Sahayak", ["sahayak"]),
    s("skill_mortar_mixing", "Mortar Mixing", ["mortar mix"]),
    s("skill_supervisor_scaffold_inspection", "Supervisor Scaffold Inspection", ["scaffold inspection"]),
  ];

  it("flags a level word plus the domain's own name", () => {
    const flagged = detectSeniorityLabels(skills, edges, { domains: MASONRY_DOMAINS });
    const ids = flagged.map((f) => f.skill_id);
    expect(ids).toContain("skill_assistant_masonry");
    const finding = flagged.find((f) => f.skill_id === "skill_assistant_masonry");
    expect(finding?.seniority_tokens).toEqual(["assistant"]);
    // "masonry" is absorbed as a variant of the domain's "mason" — it adds nothing that the
    // trade itself does not already say.
    expect(finding?.domain_name_tokens).toEqual(["masonry"]);
    expect(finding?.residual_tokens).toEqual([]);
    expect(finding?.job_domain_ids).toEqual([ASSISTANT_MASON]);
  });

  it("flags a level word plus generic filler", () => {
    const ids = detectSeniorityLabels(skills, edges, { domains: MASONRY_DOMAINS }).map((f) => f.skill_id);
    expect(ids).toContain("skill_helper_work");
  });

  it("flags the Hinglish level words", () => {
    const ids = detectSeniorityLabels(skills, edges, { domains: MASONRY_DOMAINS }).map((f) => f.skill_id);
    expect(ids).toContain("skill_sahayak");
    expect(SENIORITY_WORDS).toContain("sahayak");
    expect(SENIORITY_WORDS).toContain("madadgar");
  });

  it("does NOT flag a real technical skill that lives in the helper domain", () => {
    // The half that decides whether this detector is usable. "Mortar Mixing" is emitted by
    // the Assistant Mason domain and is a genuine, screenable capability.
    const ids = detectSeniorityLabels(skills, edges, { domains: MASONRY_DOMAINS }).map((f) => f.skill_id);
    expect(ids).not.toContain("skill_mortar_mixing");
  });

  it("does NOT flag a seniority word that QUALIFIES a real technical skill", () => {
    const ids = detectSeniorityLabels(skills, edges, { domains: MASONRY_DOMAINS }).map((f) => f.skill_id);
    expect(ids).not.toContain("skill_supervisor_scaffold_inspection");
    const breakdown = classifySeniorityLabel("Supervisor Scaffold Inspection", ["Assistant Mason"]);
    expect(breakdown.seniority_tokens).toEqual(["supervisor"]);
    expect(breakdown.residual_tokens).toEqual(["scaffold", "inspection"]);
    expect(breakdown.flagged).toBe(false);
  });

  it("returns ONLY the flags, sorted, so the report is about bad behaviour", () => {
    const flagged = detectSeniorityLabels(skills, edges, { domains: MASONRY_DOMAINS });
    expect(flagged.map((f) => f.skill_id)).toEqual([
      "skill_assistant_masonry",
      "skill_helper_work",
      "skill_sahayak",
    ]);
  });

  it("requires a level word — an all-generic label is the validator's job, not this one", () => {
    // SKILL_LABEL_OVER_GENERIC already reports "Machine Work" under a code a reviewer knows.
    // Reporting it here as well would put one fault in two reports under two names.
    expect(classifySeniorityLabel("Machine Work", ["Stone Mason"]).flagged).toBe(false);
  });

  it("treats a bare level word as a flag even with no domain context", () => {
    for (const word of ["Helper", "Trainee", "Apprentice", "Supervisor", "In-Charge", "Madadgar"]) {
      expect(classifySeniorityLabel(word, []).flagged, word).toBe(true);
    }
  });

  it("keeps `in-charge` as ONE concept even though the tokenizer splits on the hyphen", () => {
    const breakdown = classifySeniorityLabel("In-Charge", []);
    expect(breakdown.seniority_tokens).toEqual(["in-charge"]);
    expect(breakdown.residual_tokens).toEqual([]);
  });

  it("does not let the domain-stem rule eat a technical token", () => {
    // `welding` and `welder` share only four characters, one short of
    // MIN_DOMAIN_STEM_MATCH — so `welding` survives as a residual and the label is not
    // flagged. Four would have folded them and condemned a real skill.
    expect(MIN_DOMAIN_STEM_MATCH).toBe(5);
    const breakdown = classifySeniorityLabel("Trainee Welding Position Control", ["Welder"]);
    expect(breakdown.residual_tokens).toContain("welding");
    expect(breakdown.flagged).toBe(false);
  });

  it("skips a skill with no edges rather than guessing which domain it belongs to", () => {
    const flagged = detectSeniorityLabels([s("skill_helper", "Helper", ["helper"])], [], {
      domains: MASONRY_DOMAINS,
    });
    expect(flagged.map((f) => f.skill_id)).toEqual(["skill_helper"]);
    expect(flagged[0]?.job_domain_ids).toEqual([]);
  });
});

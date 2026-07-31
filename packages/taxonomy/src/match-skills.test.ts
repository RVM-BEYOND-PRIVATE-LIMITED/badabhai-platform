import { describe, expect, it } from "vitest";
import { INDUSTRIES, ROLES, getIndustry, labelForTaxonomyId } from "./index";
import {
  ATTRIBUTE_TO_MATCH_SKILLS,
  MATCH_SKILLS,
  MATCH_SKILL_RELATION_PAIRS,
  RELATED_MATCH_SKILLS,
  ROLE_TO_MATCH_SKILL,
  TRADE_TO_MATCH_SKILL,
  getMatchSkill,
  isMatchSkillId,
  matchSkillForRole,
  matchSkillForTrade,
  matchSkillIndustry,
  matchSkillLabel,
  matchSkillsForAttribute,
  relatedMatchSkills,
  type MatchSkillId,
} from "./match-skills";
import { SKILL_CORPUS } from "./skill-corpus";
import { TRADE_KEYS } from "./enums";

const MATCH_SKILL_IDS = new Set<string>(MATCH_SKILLS.map((s) => s.id));

describe("Matching V1 — the mskill_* vocabulary", () => {
  it("mints a NEW id space that collides with nothing existing", () => {
    for (const s of MATCH_SKILLS) {
      expect(s.id.startsWith("mskill_")).toBe(true);
    }
    // No `mskill_*` id may collide with a role / corpus-skill id.
    const existing = new Set<string>([
      ...ROLES.map((r) => r.id),
      ...SKILL_CORPUS.map((s) => s.skillId),
    ]);
    for (const s of MATCH_SKILLS) expect(existing.has(s.id)).toBe(false);
  });

  it("ids are unique and every skill sits in a known industry", () => {
    expect(MATCH_SKILL_IDS.size).toBe(MATCH_SKILLS.length);
    for (const s of MATCH_SKILLS) {
      expect(getIndustry(s.industryId), s.id).toBeDefined();
      expect(s.label.trim()).not.toBe("");
    }
  });

  it("keeps ind_industrial_manufacturing at position 0 and adds quick commerce", () => {
    expect(INDUSTRIES[0].id).toBe("ind_industrial_manufacturing");
    expect(getIndustry("ind_quick_commerce")?.name).toBe("Quick-commerce Delivery");
    expect(matchSkillIndustry("mskill_delivery_rider")).toBe("ind_quick_commerce");
    expect(matchSkillIndustry("mskill_cnc_turner")).toBe("ind_industrial_manufacturing");
  });

  it("resolves labels, membership and unknown ids honestly", () => {
    expect(matchSkillLabel("mskill_vmc_operator")).toBe("VMC Operator");
    expect(matchSkillLabel("mskill_nope")).toBeUndefined();
    expect(getMatchSkill("mskill_nope")).toBeUndefined();
    expect(isMatchSkillId("mskill_fitter")).toBe(true);
    expect(isMatchSkillId("skill_fitter_occupation")).toBe(false);
    expect(isMatchSkillId(42)).toBe(false);
  });

  it("labelForTaxonomyId renders mskill_* ids from the curated label", () => {
    // The generic operator is the case a prettifier would get WRONG.
    expect(labelForTaxonomyId("mskill_cnc_operator_general")).toBe("CNC Operator");
    expect(labelForTaxonomyId("mskill_delivery_rider")).toBe("Delivery Rider");
    // Unknown mskill_* still never leaks the raw id.
    expect(labelForTaxonomyId("mskill_forklift_driver")).toBe("Forklift Driver");
  });
});

describe("RELATED_MATCH_SKILLS — the curated symmetric relation", () => {
  it("covers every match skill exactly once", () => {
    expect(Object.keys(RELATED_MATCH_SKILLS).sort()).toEqual(
      MATCH_SKILLS.map((s) => s.id).sort(),
    );
  });

  it("IS SYMMETRIC — if A lists B then B lists A", () => {
    for (const [skillId, related] of Object.entries(RELATED_MATCH_SKILLS)) {
      for (const other of related) {
        expect(
          RELATED_MATCH_SKILLS[other],
          `${other} must list ${skillId} back`,
        ).toContain(skillId);
      }
    }
  });

  it("has no self-relations and no duplicates, and every id resolves", () => {
    for (const [skillId, related] of Object.entries(RELATED_MATCH_SKILLS)) {
      expect(MATCH_SKILL_IDS.has(skillId)).toBe(true);
      expect(new Set(related).size).toBe(related.length);
      for (const other of related) {
        expect(other).not.toBe(skillId);
        expect(MATCH_SKILL_IDS.has(other)).toBe(true);
      }
    }
  });

  it("reproduces the doc's reference relation for the VMC Operator job", () => {
    expect(RELATED_MATCH_SKILLS.mskill_vmc_operator).toEqual([
      "mskill_hmc_operator",
      "mskill_cnc_setter_operator",
      "mskill_cnc_turner",
    ]);
  });

  it("leaves the delivery rider with NO relations (E1 depends on it)", () => {
    expect(RELATED_MATCH_SKILLS.mskill_delivery_rider).toEqual([]);
    expect(relatedMatchSkills("mskill_delivery_rider")).toEqual([]);
    expect(relatedMatchSkills("mskill_nope")).toEqual([]);
  });

  it("welding is a mutually related family", () => {
    expect([...RELATED_MATCH_SKILLS.mskill_mig_welder].sort()).toEqual([
      "mskill_arc_welder",
      "mskill_tig_welder",
    ]);
    expect([...RELATED_MATCH_SKILLS.mskill_tig_welder].sort()).toEqual([
      "mskill_arc_welder",
      "mskill_mig_welder",
    ]);
    expect([...RELATED_MATCH_SKILLS.mskill_arc_welder].sort()).toEqual([
      "mskill_mig_welder",
      "mskill_tig_welder",
    ]);
  });

  it("flattens to both directions, deduped, deterministically ordered", () => {
    const directed = Object.entries(RELATED_MATCH_SKILLS).flatMap(([id, rel]) =>
      rel.map((r) => `${id} ${r}`),
    );
    // Author-side edges are already symmetric, so both-directions == the same count.
    expect(MATCH_SKILL_RELATION_PAIRS).toHaveLength(directed.length);
    expect(new Set(MATCH_SKILL_RELATION_PAIRS.map((p) => `${p.skillId} ${p.relatedSkillId}`)).size)
      .toBe(MATCH_SKILL_RELATION_PAIRS.length);

    for (const pair of MATCH_SKILL_RELATION_PAIRS) {
      expect(MATCH_SKILL_IDS.has(pair.skillId)).toBe(true);
      expect(MATCH_SKILL_IDS.has(pair.relatedSkillId)).toBe(true);
      expect(RELATED_MATCH_SKILLS[pair.skillId]).toContain(pair.relatedSkillId);
    }

    const keys = MATCH_SKILL_RELATION_PAIRS.map((p) => `${p.skillId} ${p.relatedSkillId}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("bridge — ROLE_TO_MATCH_SKILL", () => {
  it("is EXHAUSTIVE over ROLES at runtime, not just at compile time", () => {
    const keys = Object.keys(ROLE_TO_MATCH_SKILL).sort();
    expect(keys).toEqual(ROLES.map((r) => r.id).sort());
    expect(keys).toHaveLength(13);
  });

  it("maps every role to a real match skill", () => {
    for (const role of ROLES) {
      const mapped = matchSkillForRole(role.id);
      expect(mapped, role.id).toBeDefined();
      expect(MATCH_SKILL_IDS.has(mapped as string)).toBe(true);
    }
    expect(matchSkillForRole("role_nope")).toBeUndefined();
  });

  it("pins the ruled 1:1 mappings", () => {
    expect(matchSkillForRole("role_cnc_turner_operator")).toBe("mskill_cnc_turner");
    expect(matchSkillForRole("role_welder")).toBe("mskill_mig_welder");
    expect(matchSkillForRole("role_cnc_operator")).toBe("mskill_cnc_operator_general");
    expect(matchSkillForRole("role_interior_designer")).toBe("mskill_interior_designer");
  });
});

describe("bridge — ATTRIBUTE_TO_MATCH_SKILLS", () => {
  it("is EXHAUSTIVE over SKILL_CORPUS (a new corpus skill must be triaged)", () => {
    expect(Object.keys(ATTRIBUTE_TO_MATCH_SKILLS).sort()).toEqual(
      SKILL_CORPUS.map((s) => s.skillId).sort(),
    );
  });

  it("every key is a corpus skill and every value is a valid MatchSkillId", () => {
    const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
    for (const [skillId, mapped] of Object.entries(ATTRIBUTE_TO_MATCH_SKILLS)) {
      expect(corpusIds.has(skillId), skillId).toBe(true);
      expect(new Set(mapped).size).toBe(mapped.length);
      for (const m of mapped) expect(MATCH_SKILL_IDS.has(m), `${skillId} -> ${m}`).toBe(true);
    }
  });

  it("maps the operations that genuinely imply a posting-level skill", () => {
    expect(matchSkillsForAttribute("skill_turning")).toEqual(["mskill_cnc_turner"]);
    expect(matchSkillsForAttribute("skill_milling")).toEqual(["mskill_vmc_operator"]);
    expect(matchSkillsForAttribute("skill_mig_welding")).toEqual(["mskill_mig_welder"]);
    expect(matchSkillsForAttribute("skill_tig_welding")).toEqual(["mskill_tig_welder"]);
    expect(matchSkillsForAttribute("skill_arc_welding")).toEqual(["mskill_arc_welder"]);
    expect(matchSkillsForAttribute("skill_cmm")).toEqual(["mskill_quality_inspector"]);
    expect(matchSkillsForAttribute("skill_dimensional_inspection")).toEqual([
      "mskill_quality_inspector",
    ]);
    expect(matchSkillsForAttribute("skill_bench_fitting")).toEqual(["mskill_fitter"]);
    expect(matchSkillsForAttribute("skill_mechanical_assembly")).toEqual(["mskill_fitter"]);
    expect(matchSkillsForAttribute("skill_cam_software")).toEqual(["mskill_cam_programmer"]);
    expect(matchSkillsForAttribute("skill_cnc_programming")).toEqual(["mskill_cnc_programmer"]);
  });

  it("leaves PURE ATTRIBUTES unmapped — deliberately", () => {
    // These are things nearly every machinist does. Mapping them would reach a lathe
    // hand for a programmer's vacancy on the strength of owning a micrometer.
    for (const attributeOnly of [
      "skill_gdt_reading",
      "skill_tool_offset_setting",
      "skill_fanuc",
      "skill_siemens",
      "skill_mitsubishi",
      "skill_measuring_instruments",
      "skill_fixture_setup",
      "skill_drilling",
      "skill_boring",
      "skill_tapping_threading",
      "skill_deburring",
      "skill_cad_interpretation",
    ]) {
      expect(matchSkillsForAttribute(attributeOnly), attributeOnly).toEqual([]);
    }
    expect(matchSkillsForAttribute("skill_not_a_real_id")).toEqual([]);
  });
});

describe("bridge — TRADE_TO_MATCH_SKILL", () => {
  it("is EXHAUSTIVE over TradeKey", () => {
    expect(Object.keys(TRADE_TO_MATCH_SKILL).sort()).toEqual([...TRADE_KEYS].sort());
  });

  it("maps every trade key to a real match skill", () => {
    for (const key of TRADE_KEYS) {
      const mapped = matchSkillForTrade(key);
      expect(mapped, key).toBeDefined();
      expect(MATCH_SKILL_IDS.has(mapped as MatchSkillId)).toBe(true);
    }
    expect(matchSkillForTrade("not_a_trade")).toBeUndefined();
  });

  it("lands the four trades with no V1 counterpart on the GENERIC operator", () => {
    for (const key of [
      "cnc_operator",
      "production_engineer",
      "tool_room_technician",
      "machine_operator",
    ] as const) {
      expect(matchSkillForTrade(key), key).toBe("mskill_cnc_operator_general");
    }
  });
});

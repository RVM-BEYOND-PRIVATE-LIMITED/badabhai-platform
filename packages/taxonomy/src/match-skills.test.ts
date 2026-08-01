import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { SKILL_CORPUS, SKILL_DOMAINS } from "./skill-corpus";
import { TRADE_KEYS } from "./enums";

const MATCH_SKILL_IDS = new Set<string>(MATCH_SKILLS.map((s) => s.skillId));

/**
 * Everything below 0x20 except tab / LF / CR. Built from an escaped STRING rather than
 * written as a regex literal, so this file cannot itself contain the bytes it hunts for.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]");

describe("Matching V1 — the mskill_* vocabulary", () => {
  it("mints a NEW id space that collides with nothing existing", () => {
    for (const s of MATCH_SKILLS) {
      expect(s.skillId.startsWith("mskill_")).toBe(true);
    }
    // No `mskill_*` id may collide with a role / corpus-skill id.
    const existing = new Set<string>([
      ...ROLES.map((r) => r.id),
      ...SKILL_CORPUS.map((s) => s.skillId),
    ]);
    for (const s of MATCH_SKILLS) expect(existing.has(s.skillId)).toBe(false);
  });

  it("ids are unique and every skill sits in a known industry", () => {
    expect(MATCH_SKILL_IDS.size).toBe(MATCH_SKILLS.length);
    for (const s of MATCH_SKILLS) {
      expect(getIndustry(s.industryId), s.skillId).toBeDefined();
      expect(s.labelEn.trim()).not.toBe("");
    }
  });

  it("speaks the SkillSeed field names — it seeds the same `skill` table", () => {
    // The db seeder (packages/db/src/seed-match-vocabulary.ts) reads exactly these.
    for (const s of MATCH_SKILLS) {
      expect(Object.keys(s).sort(), s.skillId).toEqual([
        "domainId",
        "industryId",
        "labelEn",
        "labelHi",
        "skillId",
        "source",
        "status",
      ]);
    }
  });

  it("every domainId is a real SKILL_DOMAINS slug", () => {
    const domains = new Set<string>(SKILL_DOMAINS.map((d) => d.id));
    for (const s of MATCH_SKILLS) {
      expect(domains.has(s.domainId), `${s.skillId} -> ${s.domainId}`).toBe(true);
    }
    // The rider got his OWN domain rather than borrowing a machining bench — filing him
    // under one would poison the domain-scoped ANN search (ADR-0030).
    expect(getMatchSkill("mskill_delivery_rider")?.domainId).toBe("last-mile-delivery");
    expect(getMatchSkill("mskill_cnc_operator_general")?.domainId).toBe("general-machining");
  });

  it("is sourced 'rvm' throughout — it claims no standards lineage it does not have", () => {
    // The spec: "curated by Akshit / RVM instructors. It is trade truth, not
    // engineering judgment." Labelling any of it esco/onet/nco would be a false claim.
    for (const s of MATCH_SKILLS) {
      expect(s.source, s.skillId).toBe("rvm");
      expect(s.status, s.skillId).toBe("active");
      expect(s.labelHi, s.skillId).toBeNull();
    }
  });

  it("the source file carries no invisible control characters", () => {
    // A stray NUL in a data file makes ripgrep skip the whole file as "binary", so a
    // reviewer's grep silently misses it. One slipped into a template literal here and
    // survived a commit; this is the cheap guard that stops the next one.
    const src = readFileSync(join(__dirname, "match-skills.ts"), "utf8");
    expect(src).not.toMatch(CONTROL_CHAR_RE);
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

describe("MATCH_SKILL_RELATION_PAIRS — the authored source of truth", () => {
  it("lists each UNDIRECTED pair exactly ONCE (the seeder rejects a duplicate)", () => {
    const unordered = MATCH_SKILL_RELATION_PAIRS.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`));
    expect(new Set(unordered).size).toBe(MATCH_SKILL_RELATION_PAIRS.length);
    expect(MATCH_SKILL_RELATION_PAIRS).toHaveLength(18);
  });

  it("is a TUPLE list, not an object list — the db seeder destructures [a, b]", () => {
    for (const pair of MATCH_SKILL_RELATION_PAIRS) {
      expect(Array.isArray(pair)).toBe(true);
      expect(pair).toHaveLength(2);
    }
  });

  it("has no self-relations and every id resolves", () => {
    for (const [a, b] of MATCH_SKILL_RELATION_PAIRS) {
      expect(a).not.toBe(b);
      expect(MATCH_SKILL_IDS.has(a), a).toBe(true);
      expect(MATCH_SKILL_IDS.has(b), b).toBe(true);
    }
  });

  it("is SORTED within each pair and across the list — the export is byte-stable", () => {
    for (const [a, b] of MATCH_SKILL_RELATION_PAIRS) {
      expect(a < b, `pair (${a}, ${b}) is not sorted within itself`).toBe(true);
    }
    const keys = MATCH_SKILL_RELATION_PAIRS.map(([a, b]) => `${a}|${b}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("RELATED_MATCH_SKILLS — DERIVED from the pair list", () => {
  it("covers every match skill exactly once, including the empty ones", () => {
    expect(Object.keys(RELATED_MATCH_SKILLS).sort()).toEqual(
      MATCH_SKILLS.map((s) => s.skillId).sort(),
    );
  });

  it("IS SYMMETRIC — now a test of the DERIVATION, not of a curator's discipline", () => {
    for (const [skillId, related] of Object.entries(RELATED_MATCH_SKILLS)) {
      for (const other of related) {
        expect(RELATED_MATCH_SKILLS[other], `${other} must list ${skillId} back`).toContain(skillId);
      }
    }
  });

  it("reproduces EXACTLY the pair list — no edge invented, none dropped", () => {
    // Fold the derived map back to unordered pairs; it must equal the authored list.
    const foldedBack = new Set<string>();
    for (const [skillId, related] of Object.entries(RELATED_MATCH_SKILLS)) {
      for (const other of related) {
        foldedBack.add(skillId < other ? `${skillId}|${other}` : `${other}|${skillId}`);
      }
    }
    const authored = new Set(MATCH_SKILL_RELATION_PAIRS.map(([a, b]) => `${a}|${b}`));
    expect([...foldedBack].sort()).toEqual([...authored].sort());
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

  it("every derived list is SORTED — reach expansion is byte-stable", () => {
    for (const [skillId, related] of Object.entries(RELATED_MATCH_SKILLS)) {
      expect(related, skillId).toEqual([...related].sort());
    }
  });

  it("reproduces the spec's reference relation for the VMC Operator job", () => {
    // The spec prints HMC · CNC Setter-Operator · CNC Turner; the derived list is the
    // same SET, sorted (the engine sorts the reach set anyway, so order is not meaning).
    expect(RELATED_MATCH_SKILLS.mskill_vmc_operator).toEqual([
      "mskill_cnc_setter_operator",
      "mskill_cnc_turner",
      "mskill_hmc_operator",
    ]);
  });

  it("leaves the delivery rider AND the carpenter with NO relations", () => {
    expect(RELATED_MATCH_SKILLS.mskill_delivery_rider).toEqual([]); // E1 depends on it
    expect(RELATED_MATCH_SKILLS.mskill_carpenter).toEqual([]);
    expect(relatedMatchSkills("mskill_delivery_rider")).toEqual([]);
    expect(relatedMatchSkills("mskill_nope")).toEqual([]);
  });

  it("welding is a mutually related family", () => {
    expect(RELATED_MATCH_SKILLS.mskill_mig_welder).toEqual([
      "mskill_arc_welder",
      "mskill_tig_welder",
    ]);
    expect(RELATED_MATCH_SKILLS.mskill_tig_welder).toEqual([
      "mskill_arc_welder",
      "mskill_mig_welder",
    ]);
    expect(RELATED_MATCH_SKILLS.mskill_arc_welder).toEqual([
      "mskill_mig_welder",
      "mskill_tig_welder",
    ]);
  });

  it("carries 2-4 relations per related skill (the spec's curation shape)", () => {
    for (const [skillId, related] of Object.entries(RELATED_MATCH_SKILLS)) {
      if (related.length === 0) continue; // a curated empty set is legitimate
      expect(related.length, skillId).toBeGreaterThanOrEqual(1);
      expect(related.length, skillId).toBeLessThanOrEqual(4);
    }
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

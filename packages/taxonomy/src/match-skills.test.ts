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
import { PROMOTABLE_SKILL_IDS } from "./promotable-skills";
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
  // Q1 (owner-ratified 2026-08-26) WIDENED this contract. It used to be exhaustive over
  // SKILL_CORPUS alone, which sounded like full protection and was not: a promotable skill
  // that never entered the corpus was not "unmapped and failing", it was outside the question
  // being asked — 96 of them, able to go live reaching nothing with no test failing. The
  // universe is now the corpus PLUS the promotable batch.
  const COVERED = [...SKILL_CORPUS.map((s) => s.skillId), ...PROMOTABLE_SKILL_IDS];

  it("is EXHAUSTIVE over SKILL_CORPUS + the promotable batch (a new skill must be triaged)", () => {
    expect(Object.keys(ATTRIBUTE_TO_MATCH_SKILLS).sort()).toEqual([...COVERED].sort());
  });

  it("covers BOTH universes, and they are disjoint — neither alone is sufficient", () => {
    // Stated explicitly because asserting only over the corpus is the exact regression this
    // widening exists to prevent, and it would still pass 49 of the keys.
    const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
    expect(corpusIds.size).toBe(49);
    expect(PROMOTABLE_SKILL_IDS).toHaveLength(96);
    expect(PROMOTABLE_SKILL_IDS.filter((id) => corpusIds.has(id))).toEqual([]);
    expect(Object.keys(ATTRIBUTE_TO_MATCH_SKILLS)).toHaveLength(145);
  });

  it("every key is in one of those universes and every value is a valid MatchSkillId", () => {
    const covered = new Set(COVERED);
    for (const [skillId, mapped] of Object.entries(ATTRIBUTE_TO_MATCH_SKILLS)) {
      expect(covered.has(skillId), skillId).toBe(true);
      expect(new Set(mapped).size).toBe(mapped.length);
      for (const m of mapped) expect(MATCH_SKILL_IDS.has(m), `${skillId} -> ${m}`).toBe(true);
    }
  });

  it("the promotable batch got exactly the FIVE owner-ratified mappings", () => {
    // Ratified 2026-08-26. Everything else in the batch is an explicit "stays an attribute".
    // A sixth mapping appearing here is a product decision and must arrive with one.
    const mapped = PROMOTABLE_SKILL_IDS.filter(
      (id) => (ATTRIBUTE_TO_MATCH_SKILLS[id] ?? []).length > 0,
    );
    expect(mapped.sort()).toEqual([
      "skill_drain_cleaning_and_unclogging",
      "skill_hardness_testing",
      "skill_leak_repair_in_water_lines",
      "skill_non_destructive_testing_of_castings",
      "skill_sanitary_fixture_installation",
    ]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_sanitary_fixture_installation"]).toEqual(["mskill_plumber"]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_leak_repair_in_water_lines"]).toEqual(["mskill_plumber"]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_drain_cleaning_and_unclogging"]).toEqual(["mskill_plumber"]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_hardness_testing"]).toEqual(["mskill_quality_inspector"]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_non_destructive_testing_of_castings"]).toEqual([
      "mskill_quality_inspector",
    ]);
  });

  it("the vocabulary was NOT expanded to make the batch fit", () => {
    // The owner ruled that skills with no legitimate existing mskill stay unmatched rather
    // than earning a new concept. 62 of the 96 are in families with no mskill at all.
    expect(MATCH_SKILLS).toHaveLength(18);
  });

  it("the REVIEW cases were all closed as INTENTIONALLY_UNMATCHED, not quietly mapped", () => {
    // Owner ruling 2026-08-26: conservative disposition. Each of these was a live question
    // in the triage pack; each was answered "no". Pinned so a later edit cannot reopen one
    // by accident.
    for (const id of [
      "skill_lathe_chuck_mounting",
      "skill_body_panel_alignment",
      "skill_bearing_replacement",
      "skill_pump_and_valve_repair",
      "skill_shaft_and_coupling_alignment",
      "skill_pipe_bending",
      "skill_pipe_support_and_clamping",
      "skill_pressure_testing_of_pipelines",
      "skill_solvent_cement_jointing",
      "skill_first_piece_approval",
      "skill_sub_assembly_quality_checking",
      "skill_surface_finish_inspection",
      "skill_inspection_report_recording",
      "skill_weld_bead_inspection",
      "skill_structural_fit_up_and_tacking",
      "skill_electrode_selection",
    ]) {
      expect(ATTRIBUTE_TO_MATCH_SKILLS[id], id).toEqual([]);
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

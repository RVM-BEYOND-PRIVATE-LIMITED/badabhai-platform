/**
 * @badabhai/taxonomy — Matching V1 SKILL vocabulary (the `mskill_*` id space).
 *
 * CEO-ratified "BadaBhai Matching Algorithm V1" (2026-07-30). V1 draws a hard line
 * that the pre-V1 vocabulary blurred:
 *
 *   SKILL      = what a company POSTS A JOB FOR. Role-level. It is the ONLY thing
 *                matched on. That is this file (`mskill_*`).
 *   ATTRIBUTE  = what a worker can DO on the shop floor (turning, GD&T, Fanuc,
 *                micrometer). Shown on a profile, NEVER matched. That is the
 *                existing operation-level `SKILL_CORPUS` (`skill_*`) — untouched.
 *
 * A NEW id space is minted on purpose: `mskill_*` cannot collide with `skill_*`
 * (corpus attributes), `role_*` (canonical occupations) or `trade_*`. Every existing
 * export in this package keeps its id and its spelling — this file is ADDITIVE ONLY.
 *
 * IMMUTABILITY: an `mskill_*` id is permanent and never reused (same discipline as
 * ADR-0030 SG-5 for `skill_*`). The list grows; entries are appended, never renamed
 * and never reordered.
 *
 * PURE DATA. No PII, no clock, no I/O. Consumed by the deterministic
 * `@badabhai/match-engine` — never produced or read by an LLM (CLAUDE.md §2 #4).
 */

import type { TradeKey } from "./enums";
import type { IndustryId, RoleId } from "./index";

/** One V1 match skill — a postable, role-level job title. */
export interface MatchSkillNode {
  id: string;
  label: string;
  industryId: IndustryId;
}

/**
 * The V1 match-skill vocabulary.
 *
 * APPEND ONLY. Ordering is authoritative for nothing except readability, but the
 * ids are permanent, so entries are never removed and never re-spelled.
 */
export const MATCH_SKILLS = [
  // ---- CNC / machining family (the launch wedge) ----
  {
    id: "mskill_cnc_turner",
    label: "CNC Turner",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_vmc_operator",
    label: "VMC Operator",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_hmc_operator",
    label: "HMC Operator",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_cnc_setter_operator",
    label: "CNC Setter-Operator",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_cnc_programmer",
    label: "CNC Programmer",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_cam_programmer",
    label: "CAM Programmer",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_cnc_grinding_operator",
    label: "CNC Grinding Operator",
    industryId: "ind_industrial_manufacturing",
  },
  {
    // The GENERIC CNC operator — names no machine family ON PURPOSE (same rationale as
    // `role_cnc_operator`, TD94): it is the honest landing spot for a worker or a job
    // that says only "CNC operator", and it must never displace a stated specialisation.
    id: "mskill_cnc_operator_general",
    label: "CNC Operator",
    industryId: "ind_industrial_manufacturing",
  },

  // ---- Welding family ----
  {
    id: "mskill_mig_welder",
    label: "MIG Welder",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_tig_welder",
    label: "TIG Welder",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_arc_welder",
    label: "Arc Welder",
    industryId: "ind_industrial_manufacturing",
  },

  // ---- Fitting / quality ----
  {
    id: "mskill_fitter",
    label: "Fitter",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_quality_inspector",
    label: "Quality Inspector",
    industryId: "ind_industrial_manufacturing",
  },

  // ---- Adjacent trades already carried by ROLES ----
  {
    id: "mskill_plumber",
    label: "Plumber",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_carpenter",
    label: "Carpenter",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_designer",
    label: "Designer",
    industryId: "ind_industrial_manufacturing",
  },
  {
    id: "mskill_interior_designer",
    label: "Interior Designer",
    industryId: "ind_industrial_manufacturing",
  },

  // ---- Quick commerce ----
  {
    // The founder's own worked example (E1): a man who rode for a quick-commerce
    // platform AND ran a CNC lathe. Without this id his delivery history has nowhere
    // to live, and the "delivery months contribute nothing to a factory job" rule is
    // untestable. It is a REAL row, not an illustration.
    id: "mskill_delivery_rider",
    label: "Delivery Rider",
    industryId: "ind_quick_commerce",
  },
] as const satisfies readonly MatchSkillNode[];

export type MatchSkillId = (typeof MATCH_SKILLS)[number]["id"];

const _MATCH_SKILL_BY_ID = new Map<string, MatchSkillNode>(MATCH_SKILLS.map((s) => [s.id, s]));

/** Resolve a match skill by id. `undefined` for anything outside the closed set. */
export function getMatchSkill(id: string): MatchSkillNode | undefined {
  return _MATCH_SKILL_BY_ID.get(id);
}

/** Closed-set membership test — the boundary guard for any caller-supplied id. */
export function isMatchSkillId(value: unknown): value is MatchSkillId {
  return typeof value === "string" && _MATCH_SKILL_BY_ID.has(value);
}

/**
 * English label for a match skill. `undefined` for an unknown id — callers that must
 * always render something use `labelForTaxonomyId`, which falls back to prettifying.
 */
export function matchSkillLabel(id: string): string | undefined {
  return _MATCH_SKILL_BY_ID.get(id)?.label;
}

/** The industry a match skill belongs to (drives per-industry tenure). */
export function matchSkillIndustry(id: string): IndustryId | undefined {
  return _MATCH_SKILL_BY_ID.get(id)?.industryId;
}

/**
 * RELATED SKILLS — the flat, curated, SYMMETRIC relation.
 *
 * This is trade truth, owned by the RVM instructors (Akshit's team), not a computed
 * similarity: "a man who runs a VMC can run an HMC". It is flat by design — there is
 * no hierarchy, no distance metric, no embedding. A related match is TIER 2; an exact
 * match is TIER 1 (see `@badabhai/match-engine`).
 *
 * SYMMETRY IS AN INVARIANT, not a convention: if A lists B then B lists A. It is
 * authored by hand here (so an instructor can read and edit one map) and enforced by
 * `match-skills.test.ts`. No self-relations. Every id resolves.
 *
 * Curating a relation means answering ONE question: "would a shop that posted A
 * seriously consider a man whose trade is B?" Where the honest answer is no, the
 * array is empty — an empty relation set is a legitimate curation result, never an
 * oversight (see `mskill_carpenter`, `mskill_delivery_rider`).
 */
export const RELATED_MATCH_SKILLS: Record<MatchSkillId, readonly MatchSkillId[]> = {
  // CNC family. `mskill_vmc_operator` is the doc's reference job and its relation set
  // is exactly the three the doc prints — HMC, CNC Setter-Operator, CNC Turner.
  mskill_cnc_turner: [
    "mskill_vmc_operator",
    "mskill_cnc_setter_operator",
    "mskill_cnc_operator_general",
    "mskill_cnc_grinding_operator",
  ],
  mskill_vmc_operator: [
    "mskill_hmc_operator",
    "mskill_cnc_setter_operator",
    "mskill_cnc_turner",
  ],
  mskill_hmc_operator: [
    "mskill_vmc_operator",
    "mskill_cnc_setter_operator",
    "mskill_cnc_operator_general",
  ],
  mskill_cnc_setter_operator: [
    "mskill_cnc_turner",
    "mskill_vmc_operator",
    "mskill_hmc_operator",
    "mskill_cnc_programmer",
  ],
  mskill_cnc_programmer: ["mskill_cam_programmer", "mskill_cnc_setter_operator"],
  // A CAM programmer and a (CAD) designer both work the part geometry in software;
  // shops routinely move a man between the two desks.
  mskill_cam_programmer: ["mskill_cnc_programmer", "mskill_designer"],
  mskill_cnc_grinding_operator: ["mskill_cnc_turner", "mskill_cnc_operator_general"],
  mskill_cnc_operator_general: [
    "mskill_cnc_turner",
    "mskill_hmc_operator",
    "mskill_cnc_grinding_operator",
  ],

  // Welding family — MIG / TIG / Arc are mutually related.
  mskill_mig_welder: ["mskill_tig_welder", "mskill_arc_welder"],
  mskill_tig_welder: ["mskill_mig_welder", "mskill_arc_welder"],
  mskill_arc_welder: ["mskill_mig_welder", "mskill_tig_welder"],

  // Fitting / quality / plumbing. A plumber IS a pipe fitter in the Indian trade
  // vocabulary, which is why the fitter relation is real and not a stretch.
  mskill_fitter: ["mskill_quality_inspector", "mskill_plumber"],
  mskill_quality_inspector: ["mskill_fitter"],
  mskill_plumber: ["mskill_fitter"],

  // DELIBERATELY EMPTY. A carpenter is not interchangeable with any other trade in
  // this vocabulary — an interior designer specifies the work, they do not do it.
  mskill_carpenter: [],

  // Design family.
  mskill_designer: ["mskill_interior_designer", "mskill_cam_programmer"],
  mskill_interior_designer: ["mskill_designer"],

  // DELIBERATELY EMPTY. Quick-commerce riding shares no trade with a factory floor —
  // this emptiness is what makes E1 true ("delivery months contribute nothing to a
  // factory job"), so it must never be "filled in" for reach.
  mskill_delivery_rider: [],
};

/** Related match skills for an id — `[]` for an unknown id or a curated empty set. */
export function relatedMatchSkills(id: string): readonly MatchSkillId[] {
  return isMatchSkillId(id) ? RELATED_MATCH_SKILLS[id] : [];
}

/** One directed edge of the relation graph. */
export interface MatchSkillRelationPair {
  skillId: MatchSkillId;
  relatedSkillId: MatchSkillId;
}

/**
 * The relation flattened to BOTH directions, deduped and deterministically ordered —
 * the shape a `match_skill_relations` seeder consumes (one row per directed edge, so
 * a single-direction lookup is a plain indexed read).
 *
 * Derived from `RELATED_MATCH_SKILLS`, which stays the human-edited source of truth.
 */
export const MATCH_SKILL_RELATION_PAIRS: readonly MatchSkillRelationPair[] = (() => {
  const seen = new Set<string>();
  const pairs: MatchSkillRelationPair[] = [];
  for (const [skillId, related] of Object.entries(RELATED_MATCH_SKILLS)) {
    for (const relatedSkillId of related) {
      for (const [a, b] of [
        [skillId as MatchSkillId, relatedSkillId],
        [relatedSkillId, skillId as MatchSkillId],
      ] as const) {
        const key = `${a} ${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ skillId: a, relatedSkillId: b });
      }
    }
  }
  return pairs.sort((x, y) =>
    x.skillId === y.skillId
      ? x.relatedSkillId < y.relatedSkillId
        ? -1
        : x.relatedSkillId > y.relatedSkillId
          ? 1
          : 0
      : x.skillId < y.skillId
        ? -1
        : 1,
  );
})();

/* ------------------------------------------------------------------------- *
 * BRIDGE MAPS — today's data into the V1 vocabulary.
 *
 * These three maps are the ONLY seam between what BadaBhai already stores and what
 * V1 matches on. They are pure lookup tables: deterministic, reviewable by a trade
 * instructor, and free of any model call. When the worker record itself starts
 * carrying `mskill_*` rows, the bridges become vestigial rather than wrong.
 * ------------------------------------------------------------------------- */

/**
 * Canonical occupation (`role_*`) → the match skill a company would post for it.
 *
 * EXHAUSTIVE over `ROLES` by construction: the `Record<RoleId, …>` annotation makes a
 * newly minted role a COMPILE error here, and `match-skills.test.ts` re-asserts it at
 * runtime so the lock survives any loosening of the type.
 *
 * `role_welder` → `mskill_mig_welder`: the canonical role is deliberately unspecific
 * about process, MIG is the overwhelmingly common shop-floor default, and the
 * MIG↔TIG↔Arc relation carries the worker to the other two at tier 2 anyway.
 */
export const ROLE_TO_MATCH_SKILL: Record<RoleId, MatchSkillId> = {
  role_cnc_turner_operator: "mskill_cnc_turner",
  role_vmc_operator: "mskill_vmc_operator",
  role_hmc_operator: "mskill_hmc_operator",
  role_cnc_setter_operator: "mskill_cnc_setter_operator",
  role_cnc_programmer: "mskill_cnc_programmer",
  role_cam_programmer: "mskill_cam_programmer",
  role_cnc_grinding_operator: "mskill_cnc_grinding_operator",
  role_welder: "mskill_mig_welder",
  role_cnc_operator: "mskill_cnc_operator_general",
  role_plumber: "mskill_plumber",
  role_carpenter: "mskill_carpenter",
  role_designer: "mskill_designer",
  role_interior_designer: "mskill_interior_designer",
};

const _ROLE_TO_MATCH_SKILL = new Map<string, MatchSkillId>(
  Object.entries(ROLE_TO_MATCH_SKILL),
);

/** The match skill implied by a canonical role id. `undefined` if the role is unknown. */
export function matchSkillForRole(roleId: string): MatchSkillId | undefined {
  return _ROLE_TO_MATCH_SKILL.get(roleId);
}

/**
 * ATTRIBUTE (`skill_*` corpus id) → the match skills it genuinely implies (0..n).
 *
 * EXHAUSTIVE over `SKILL_CORPUS`: every corpus id appears as a key, and a corpus id
 * that implies nothing at posting level maps to `[]`. That is not padding — it forces
 * an explicit triage decision on every new corpus skill (the test fails on an
 * unmapped one) and it makes the "attributes are shown, never matched" rule visible
 * rather than implicit.
 *
 * THE EMPTY ONES ARE THE POINT. GD&T reading, tool-offset setting, Fanuc/Siemens/
 * Mitsubishi control operation, micrometer usage, fixture setup, drilling, boring,
 * tapping, deburring — these are things nearly every machinist does. Mapping them to
 * a posting-level skill would reach a lathe hand for a programmer's vacancy on the
 * strength of him owning a micrometer. They stay attributes, deliberately.
 */
export const ATTRIBUTE_TO_MATCH_SKILLS: Record<string, readonly MatchSkillId[]> = {
  // ---- Legacy placeholders: all pure attributes except CAM software ----
  skill_gdt_reading: [],
  skill_tool_offset_setting: [],
  // Editing G/M codes AT THE MACHINE is a setter's attribute, not a claim to a
  // programmer's chair. `skill_cnc_programming` is the posting-level concept.
  skill_program_editing: [],
  skill_fanuc: [],
  skill_siemens: [],
  skill_mitsubishi: [],
  skill_measuring_instruments: [],
  skill_fixture_setup: [],
  skill_cam_software: ["mskill_cam_programmer"],

  // ---- Core machining operations ----
  skill_turning: ["mskill_cnc_turner"],
  skill_milling: ["mskill_vmc_operator"],
  skill_drilling: [],
  skill_boring: [],
  skill_tapping_threading: [],
  skill_grinding_ops: ["mskill_cnc_grinding_operator"],
  skill_deburring: [],

  // ---- Programming, drawing, quality ----
  skill_cnc_programming: ["mskill_cnc_programmer"],
  // Reading a drawing is not designing one.
  skill_cad_interpretation: [],
  skill_dimensional_inspection: ["mskill_quality_inspector"],
  skill_cmm: ["mskill_quality_inspector"],
  skill_quality_control: ["mskill_quality_inspector"],

  // ---- Welding & fabrication ----
  skill_mig_welding: ["mskill_mig_welder"],
  skill_tig_welding: ["mskill_tig_welder"],
  skill_arc_welding: ["mskill_arc_welder"],
  // Cutting and sheet-metal work are fabrication attributes; neither makes a welder.
  skill_gas_cutting: [],
  skill_sheet_metal: [],

  // ---- Fitting, assembly, maintenance ----
  skill_bench_fitting: ["mskill_fitter"],
  skill_mechanical_assembly: ["mskill_fitter"],
  skill_hydraulics_pneumatics: [],
  skill_machine_maintenance: [],

  // ---- NCO occupation anchors: these ARE posting-level by construction ----
  skill_machinist_occupation: ["mskill_cnc_operator_general"],
  skill_welder_occupation: ["mskill_mig_welder"],
  skill_fitter_occupation: ["mskill_fitter"],

  // ---- Plumbing ----
  skill_pipe_fitting: ["mskill_plumber"],
  skill_drainage_systems: ["mskill_plumber"],
  skill_water_supply: ["mskill_plumber"],
  skill_plumber_occupation: ["mskill_plumber"],

  // ---- Carpentry ----
  skill_woodworking: ["mskill_carpenter"],
  skill_cabinet_making: ["mskill_carpenter"],
  skill_furniture_finishing: [],
  skill_carpenter_occupation: ["mskill_carpenter"],

  // ---- Design ----
  skill_cad_2d_drafting: ["mskill_designer"],
  skill_3d_modeling: ["mskill_designer"],
  skill_rendering_visualization: [],
  skill_designer_occupation: ["mskill_designer"],

  // ---- Interior design ----
  skill_space_planning: ["mskill_interior_designer"],
  skill_material_selection: [],
  skill_interior_designer_occupation: ["mskill_interior_designer"],
};

const _ATTRIBUTE_TO_MATCH_SKILLS = new Map<string, readonly MatchSkillId[]>(
  Object.entries(ATTRIBUTE_TO_MATCH_SKILLS),
);

const _NO_MATCH_SKILLS: readonly MatchSkillId[] = [];

/** Match skills implied by a corpus attribute id. `[]` for unknown or attribute-only. */
export function matchSkillsForAttribute(skillId: string): readonly MatchSkillId[] {
  return _ATTRIBUTE_TO_MATCH_SKILLS.get(skillId) ?? _NO_MATCH_SKILLS;
}

/**
 * `TradeKey` → match skill. EXHAUSTIVE over the `TradeKey` union.
 *
 * SCOPE: this bridge exists for the ONE-TIME conversion of the ADR-0009 seeded job
 * fixtures, which carry a `tradeKey` and no match skill. It is not a runtime path.
 *
 * Four trade keys have no exact counterpart in the V1 vocabulary —
 * `production_engineer`, `tool_room_technician`, `machine_operator` and
 * `cnc_operator` — and all land on `mskill_cnc_operator_general`. That is the honest
 * answer: the generic names no machine family, so converting to it never CLAIMS a
 * specialisation the seeded job never stated, and the CNC relation set still carries
 * the posting to turners, HMC hands and grinders at tier 2.
 */
export const TRADE_TO_MATCH_SKILL: Record<TradeKey, MatchSkillId> = {
  cnc_operator: "mskill_cnc_operator_general",
  vmc_operator: "mskill_vmc_operator",
  cnc_vmc_setter: "mskill_cnc_setter_operator",
  cnc_programmer: "mskill_cnc_programmer",
  vmc_programmer: "mskill_cnc_programmer",
  cad_designer: "mskill_designer",
  solidworks_designer: "mskill_designer",
  autocad_draftsman: "mskill_designer",
  quality_inspector: "mskill_quality_inspector",
  production_engineer: "mskill_cnc_operator_general",
  maintenance_technician: "mskill_fitter",
  tool_room_technician: "mskill_cnc_operator_general",
  machine_operator: "mskill_cnc_operator_general",
  assembly_technician: "mskill_fitter",
  fitter: "mskill_fitter",
};

const _TRADE_TO_MATCH_SKILL = new Map<string, MatchSkillId>(
  Object.entries(TRADE_TO_MATCH_SKILL),
);

/** The match skill a seeded job's `tradeKey` converts to. `undefined` if unknown. */
export function matchSkillForTrade(tradeKey: string): MatchSkillId | undefined {
  return _TRADE_TO_MATCH_SKILL.get(tradeKey);
}

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
import type { SkillDomainId, SkillSource, SkillStatus } from "./skill-corpus";

/**
 * One V1 match skill — a postable, role-level job title, and a `skill` row with
 * `kind='match_skill'`.
 *
 * SHAPE FOLLOWS `SkillSeed` (skill-corpus.ts), NOT the `{id, name}` `TaxonomyNode`
 * convention: match skills and corpus attributes seed the SAME `skill` table, so they
 * must speak the same field names. `domain_id` and `source` are NOT NULL there.
 *
 * `source` is `"rvm"` for the whole vocabulary and that is not a placeholder. The spec
 * is explicit that this list and its relations are "curated by Akshit / RVM
 * instructors — trade truth, not engineering judgment". Labelling it `esco`/`onet`/
 * `nco` would claim a standards lineage it does not have.
 */
export interface MatchSkillSeed {
  skillId: string;
  labelEn: string;
  labelHi: string | null;
  industryId: IndustryId;
  domainId: SkillDomainId;
  source: SkillSource;
  status: SkillStatus;
}

/**
 * The V1 match-skill vocabulary.
 *
 * APPEND ONLY. Ordering is authoritative for nothing except readability, but the
 * ids are permanent, so entries are never removed and never re-spelled.
 *
 * `status` is `"active"` on all eighteen, deliberately. The corpus marks the
 * trade-widening skills `provisional`, but that flag is about CANONICALIZATION
 * confidence — how safely a free-text phrase resolves to the id. This is a different
 * question: "can a company post this vacancy today?", and for all eighteen the answer
 * is yes. Nothing reads `skill.status` on the match path today, so the risk runs one
 * way: a future `WHERE status = 'active'` would silently hide a postable trade.
 *
 * `labelHi` is `null` throughout — we have no ratified Hindi labels for these yet, and
 * the corpus records an absent label as `null` rather than an English fallback.
 */
export const MATCH_SKILLS = [
  // ---- CNC / machining family (the launch wedge) ----
  {
    skillId: "mskill_cnc_turner",
    labelEn: "CNC Turner",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_vmc_operator",
    labelEn: "VMC Operator",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "vmc-machining",
    source: "rvm",
    status: "active",
  },
  {
    // `vmc-machining` names the VERTICAL centre specifically, so filing an HMC hand
    // there would mislabel him. `cnc-machining` is the general machining domain the
    // corpus already uses for turning/drilling/boring — the honest home for the
    // horizontal sibling until an `hmc-machining` slug earns its place.
    skillId: "mskill_hmc_operator",
    labelEn: "HMC Operator",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_cnc_setter_operator",
    labelEn: "CNC Setter-Operator",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_cnc_programmer",
    labelEn: "CNC Programmer",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "cnc-programming",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_cam_programmer",
    labelEn: "CAM Programmer",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "cnc-programming",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_cnc_grinding_operator",
    labelEn: "CNC Grinding Operator",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "grinding",
    source: "rvm",
    status: "active",
  },
  {
    // The GENERIC CNC operator — names no machine family ON PURPOSE (same rationale as
    // `role_cnc_operator`, TD94): it is the honest landing spot for a worker or a job
    // that says only "CNC operator", and it must never displace a stated specialisation.
    // `general-machining` is the corpus's own occupation-anchor domain — an exact fit.
    skillId: "mskill_cnc_operator_general",
    labelEn: "CNC Operator",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "general-machining",
    source: "rvm",
    status: "active",
  },

  // ---- Welding family ----
  {
    skillId: "mskill_mig_welder",
    labelEn: "MIG Welder",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "welding",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_tig_welder",
    labelEn: "TIG Welder",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "welding",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_arc_welder",
    labelEn: "Arc Welder",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "welding",
    source: "rvm",
    status: "active",
  },

  // ---- Fitting / quality ----
  {
    skillId: "mskill_fitter",
    labelEn: "Fitter",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "fitting-assembly",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_quality_inspector",
    labelEn: "Quality Inspector",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "metrology-quality",
    source: "rvm",
    status: "active",
  },

  // ---- Adjacent trades already carried by ROLES. Each sits in the SAME skill-domain
  // ---- as its corpus occupation anchor (`skill_plumber_occupation` etc.), so the
  // ---- domain-scoped search sees one consistent neighbourhood per trade.
  {
    skillId: "mskill_plumber",
    labelEn: "Plumber",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "fitting-assembly",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_carpenter",
    labelEn: "Carpenter",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "fitting-assembly",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_designer",
    labelEn: "Designer",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "cnc-programming",
    source: "rvm",
    status: "active",
  },
  {
    skillId: "mskill_interior_designer",
    labelEn: "Interior Designer",
    labelHi: null,
    industryId: "ind_industrial_manufacturing",
    domainId: "cnc-programming",
    source: "rvm",
    status: "active",
  },

  // ---- Quick commerce ----
  {
    // The founder's own worked example (E1): a man who rode for a quick-commerce
    // platform AND ran a CNC lathe. Without this id his delivery history has nowhere
    // to live, and the "delivery months contribute nothing to a factory job" rule is
    // untestable. It is a REAL row, not an illustration.
    //
    // `last-mile-delivery` is MINTED for him (skill-corpus.ts) rather than borrowing a
    // machining slug — see the note there.
    skillId: "mskill_delivery_rider",
    labelEn: "Delivery Rider",
    labelHi: null,
    industryId: "ind_quick_commerce",
    domainId: "last-mile-delivery",
    source: "rvm",
    status: "active",
  },
] as const satisfies readonly MatchSkillSeed[];

export type MatchSkillId = (typeof MATCH_SKILLS)[number]["skillId"];

const _MATCH_SKILL_BY_ID = new Map<string, MatchSkillSeed>(MATCH_SKILLS.map((s) => [s.skillId, s]));

/** Resolve a match skill by id. `undefined` for anything outside the closed set. */
export function getMatchSkill(id: string): MatchSkillSeed | undefined {
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
  return _MATCH_SKILL_BY_ID.get(id)?.labelEn;
}

/** The industry a match skill belongs to (drives per-industry tenure). */
export function matchSkillIndustry(id: string): IndustryId | undefined {
  return _MATCH_SKILL_BY_ID.get(id)?.industryId;
}

/** One UNORDERED adjacency between two match skills. */
export type MatchSkillRelationPair = readonly [MatchSkillId, MatchSkillId];

/**
 * RELATED SKILLS — the flat, curated, SYMMETRIC relation. THE SOURCE OF TRUTH.
 *
 * This is trade truth, owned by the RVM instructors (Akshit's team), not a computed
 * similarity: "a man who runs a VMC can run an HMC". It is flat by design — no
 * hierarchy, no distance metric, no embedding. A related match is TIER 2; an exact
 * match is TIER 1 (see `@badabhai/match-engine`).
 *
 * ONE EDGE, LISTED ONCE. The relation is undirected, so it is authored as unordered
 * pairs rather than as a directed map: a symmetric map has to be written twice and can
 * therefore be written WRONG twice. `RELATED_MATCH_SKILLS` below is DERIVED from this
 * list, so the two cannot drift, and the `skill_related` seeder expands each pair into
 * its two directed rows itself — it REJECTS a pair listed twice.
 *
 * Curating a relation means answering ONE question: "would a shop that posted A
 * seriously consider a man whose trade is B?" Where the honest answer is no, there is
 * no pair. An absent relation is a legitimate curation result, never an oversight:
 * `mskill_carpenter` has none (an interior designer specifies the work, they do not do
 * it), and `mskill_delivery_rider` has none — that emptiness is what makes E1 true
 * ("delivery months contribute nothing to a factory job"), so it must never be filled
 * in to widen reach.
 *
 * ORDERING IS PART OF THE CONTRACT: sorted within each pair and across the list, so the
 * export is byte-stable and a diff shows only what a curator actually changed. Enforced
 * in `match-skills.test.ts`, not merely asserted here.
 */
export const MATCH_SKILL_RELATION_PAIRS: readonly MatchSkillRelationPair[] = [
  // Welding family — MIG / TIG / Arc are mutually related (3 edges).
  ["mskill_arc_welder", "mskill_mig_welder"],
  ["mskill_arc_welder", "mskill_tig_welder"],
  // A CAM programmer and a (CAD) designer both work the part geometry in software;
  // shops routinely move a man between the two desks.
  ["mskill_cam_programmer", "mskill_cnc_programmer"],
  ["mskill_cam_programmer", "mskill_designer"],
  // CNC family.
  ["mskill_cnc_grinding_operator", "mskill_cnc_operator_general"],
  ["mskill_cnc_grinding_operator", "mskill_cnc_turner"],
  ["mskill_cnc_operator_general", "mskill_cnc_turner"],
  ["mskill_cnc_operator_general", "mskill_hmc_operator"],
  ["mskill_cnc_programmer", "mskill_cnc_setter_operator"],
  ["mskill_cnc_setter_operator", "mskill_cnc_turner"],
  ["mskill_cnc_setter_operator", "mskill_hmc_operator"],
  ["mskill_cnc_setter_operator", "mskill_vmc_operator"],
  ["mskill_cnc_turner", "mskill_vmc_operator"],
  // Design family.
  ["mskill_designer", "mskill_interior_designer"],
  // Fitting / quality / plumbing. A plumber IS a pipe fitter in the Indian trade
  // vocabulary, which is why the fitter relation is real and not a stretch.
  ["mskill_fitter", "mskill_plumber"],
  ["mskill_fitter", "mskill_quality_inspector"],
  // The spec's reference job: VMC Operator -> HMC · CNC Setter-Operator · CNC Turner.
  // Those three edges are (hmc,vmc) here, (setter,vmc) and (turner,vmc) above.
  ["mskill_hmc_operator", "mskill_vmc_operator"],
  ["mskill_mig_welder", "mskill_tig_welder"],
];

/**
 * The directed adjacency the ENGINE reads — a skill to its related skills.
 *
 * DERIVED from `MATCH_SKILL_RELATION_PAIRS`, never hand-authored, so symmetry is a
 * property of the CONSTRUCTION rather than a promise a curator has to keep twice.
 * Every match skill appears as a key, including the ones with no relations at all, so
 * a lookup never returns `undefined`. Each list is sorted, so reach expansion is
 * byte-stable.
 */
export const RELATED_MATCH_SKILLS: Record<MatchSkillId, readonly MatchSkillId[]> = (() => {
  const adjacency = new Map<MatchSkillId, Set<MatchSkillId>>();
  for (const s of MATCH_SKILLS) adjacency.set(s.skillId, new Set<MatchSkillId>());
  for (const [a, b] of MATCH_SKILL_RELATION_PAIRS) {
    adjacency.get(a)?.add(b);
    adjacency.get(b)?.add(a);
  }
  // The cast is safe BY CONSTRUCTION — the keys come from MATCH_SKILLS, so the record
  // is exhaustive over `MatchSkillId`. `match-skills.test.ts` re-asserts that at
  // runtime rather than trusting this comment.
  const derived = {} as Record<MatchSkillId, readonly MatchSkillId[]>;
  for (const [skillId, related] of adjacency) {
    derived[skillId] = [...related].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return derived;
})();

/** Related match skills for an id — `[]` for an unknown id or a curated empty set. */
export function relatedMatchSkills(id: string): readonly MatchSkillId[] {
  return isMatchSkillId(id) ? RELATED_MATCH_SKILLS[id] : [];
}

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
  // TD-01 (Phase 8 taxonomy register, RATIFIED 2026-08-18): the skill_gdt_reading +
  // skill_cad_interpretation merge target. Same triage as both predecessors — reading a
  // drawing (GD&T or CAD) is nearly universal on the shop floor and does not, by itself,
  // claim a programmer's or a quality inspector's chair.
  skill_drawing_reading: [],
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

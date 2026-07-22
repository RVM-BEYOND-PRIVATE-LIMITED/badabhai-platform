/**
 * @badabhai/taxonomy — canonical placeholder taxonomy.
 *
 * Phase 1 focuses on industrial manufacturing (CNC/VMC). These are STABLE
 * placeholder IDs: the AI extraction step canonicalizes free text into these
 * ids, and the DB stores canonical_*_id references. The list will grow, but
 * existing ids must remain stable.
 */

export interface TaxonomyNode {
  id: string;
  name: string;
  aliases?: string[];
}

export interface Role extends TaxonomyNode {
  domainId: string;
}

// ---- Industries ----
export const INDUSTRIES = [
  { id: "ind_industrial_manufacturing", name: "Industrial Manufacturing" },
] as const satisfies readonly TaxonomyNode[];

// ---- Domains (within manufacturing) ----
export const DOMAINS = [
  { id: "dom_cnc_machining", name: "CNC Machining" },
  { id: "dom_vmc_machining", name: "VMC Machining" },
  { id: "dom_hmc_machining", name: "HMC Machining" },
  { id: "dom_grinding", name: "Grinding" },
  { id: "dom_programming", name: "CNC/CAM Programming" },
  // TAX-WELD-1: welding brought in scope so an adjacent-trade welder carries a
  // canonical occupation instead of null. Additive; no existing id renamed/reused.
  { id: "dom_welding", name: "Welding" },
] as const satisfies readonly TaxonomyNode[];

// ---- Roles (initial CNC/VMC set) ----
export const ROLES = [
  { id: "role_cnc_turner_operator", name: "CNC Turner/Operator", domainId: "dom_cnc_machining" },
  { id: "role_vmc_operator", name: "VMC Operator", domainId: "dom_vmc_machining" },
  { id: "role_hmc_operator", name: "HMC Operator", domainId: "dom_hmc_machining" },
  {
    id: "role_cnc_setter_operator",
    name: "CNC Setter-Operator",
    domainId: "dom_cnc_machining",
  },
  { id: "role_cnc_programmer", name: "CNC Programmer", domainId: "dom_programming" },
  { id: "role_cam_programmer", name: "CAM Programmer", domainId: "dom_programming" },
  {
    id: "role_cnc_grinding_operator",
    name: "CNC Grinding Operator",
    domainId: "dom_grinding",
  },
  // TAX-WELD-1. Mirrored in apps/ai-service `signals._ROLES` (the Python side of the
  // same id space). The welding SKILL ids this role co-occurs with already exist,
  // active, in `skill-corpus.ts` — none was minted for this change.
  { id: "role_welder", name: "Welder", domainId: "dom_welding" },
  // TD94 (owner ruling 2026-07-21, #460). The GENERIC CNC operator: a worker who says
  // "CNC operator" and names no machine family. Mirrored in `signals._EXTRA_ROLE_TRADES`
  // on the Python side — the same mechanism `role_welder` uses (in the closed SET, but
  // assigned by one gated function rather than a keyword, `_assign_generic_cnc_role`).
  //
  // APPENDED, never inserted: every id above keeps its position and its spelling, so
  // `RoleId` only ever grows (the stability promise in this file's header). It names no
  // machine family ON PURPOSE — that is what makes it safe to fall back to, and it is
  // why it must never displace a specialisation the worker actually stated.
  { id: "role_cnc_operator", name: "CNC Operator", domainId: "dom_cnc_machining" },
] as const satisfies readonly Role[];

// ---- Skills (placeholder) ----
export const SKILLS = [
  { id: "skill_gdt_reading", name: "GD&T / drawing reading" },
  { id: "skill_tool_offset_setting", name: "Tool offset setting" },
  { id: "skill_program_editing", name: "Program editing (G & M codes)" },
  { id: "skill_fanuc", name: "Fanuc control operation" },
  { id: "skill_siemens", name: "Siemens control operation" },
  { id: "skill_mitsubishi", name: "Mitsubishi control operation" },
  { id: "skill_measuring_instruments", name: "Micrometer / Vernier / gauge usage" },
  { id: "skill_fixture_setup", name: "Fixture / job setup" },
  { id: "skill_cam_software", name: "CAM software (Mastercam/Fusion/etc.)" },
] as const satisfies readonly TaxonomyNode[];

// ---- Machines (placeholder) ----
export const MACHINES = [
  { id: "mach_cnc_lathe", name: "CNC Lathe / Turning Center" },
  { id: "mach_vmc", name: "Vertical Machining Center (VMC)" },
  { id: "mach_hmc", name: "Horizontal Machining Center (HMC)" },
  { id: "mach_cnc_grinder", name: "CNC Grinder" },
  { id: "mach_cylindrical_grinder", name: "Cylindrical Grinder" },
] as const satisfies readonly TaxonomyNode[];

export type IndustryId = (typeof INDUSTRIES)[number]["id"];
export type DomainId = (typeof DOMAINS)[number]["id"];
export type RoleId = (typeof ROLES)[number]["id"];
export type SkillId = (typeof SKILLS)[number]["id"];
export type MachineId = (typeof MACHINES)[number]["id"];

/**
 * ADJACENT roles — the taxonomy half of TD94's `secondaryRoleIds` ruling.
 *
 * `packages/reach-engine/src/scoring.ts` `scoreRole` is exact-id-match: **0.4** for a
 * null `roleId` ("trade not stated yet"), **0.0** for a non-matching one, and **0.6**
 * when any of the worker's `secondaryRoleIds` matches the job (`scoring.ts:157-158`).
 * So `role_cnc_operator` ALONE would score a plain "CNC operator" 0.0 against a
 * VMC/turner/setter/grinding vacancy — WORSE than the null they get without the mint.
 * The ruling's answer is this map: a generic CNC operator is genuinely adjacent to
 * every CNC specialisation, so carrying those ids as secondaries moves them 0.4 -> 0.6
 * with NO change to the scoring math, and without ever claiming the worker HOLDS a
 * specialisation (a secondary match scores 0.6, an exact one 1.0 — the distinction the
 * engine already draws).
 *
 * DATA ONLY — deterministic, faceless, no PII, and nothing an LLM produces or reads
 * (CLAUDE.md §2 #4: LLMs never rank; this is consumed by the deterministic engine).
 *
 * NOT YET WIRED, deliberately and reportably: `apps/api/src/reach/reach.mappers.ts`
 * `workerProfileRowToSignals` still returns a hard-coded `secondaryRoleIds: []`, and
 * `worker_profiles` has no column to persist a per-worker set. This constant exists so
 * that wiring is a lookup against the taxonomy rather than a list re-typed at the call
 * site. Roles with no adjacency are simply absent — read it with `?? []`.
 */
export const RELATED_ROLE_IDS: Partial<Record<RoleId, readonly RoleId[]>> = {
  role_cnc_operator: [
    "role_vmc_operator",
    "role_hmc_operator",
    "role_cnc_turner_operator",
    "role_cnc_setter_operator",
    "role_cnc_grinding_operator",
  ],
};

function byId<T extends TaxonomyNode>(list: readonly T[]) {
  const map = new Map(list.map((n) => [n.id, n]));
  return (id: string): T | undefined => map.get(id);
}

export const getIndustry = byId(INDUSTRIES);
export const getDomain = byId(DOMAINS);
export const getRole = byId(ROLES);
export const getSkill = byId(SKILLS);
export const getMachine = byId(MACHINES);

// ADR-0030 / TAX-2 — the canonical SKILL corpus + domain map + validators.
export * from "./skill-corpus";

// ADR-0030 / TAX-5 — PROPOSED vernacular wedge aliases (RVM ratification-gated).
export * from "./wedge-aliases";

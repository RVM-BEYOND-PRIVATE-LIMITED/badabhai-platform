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

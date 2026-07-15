/**
 * @badabhai/taxonomy — canonical SKILL corpus (ADR-0030 / TAX-2).
 *
 * The versioned, checked-in vocabulary the embedding canonicalizer resolves worker/job
 * skill phrases to. Sourced from the four ADR-0030 pillars — ESCO (skills skeleton),
 * O*NET (tool/machine depth), NCO-2015 (India occupation names), and the existing
 * first-party BadaBhai placeholder skills. See `PROVENANCE.md` for licence + attribution.
 *
 * HONEST SCOPE: this is a CURATED STARTER corpus for the CNC/VMC + adjacent-trade wedge —
 * real skill concepts in OUR OWN immutable `skill_id` space, tagged with the standard the
 * concept derives from. It is NOT the full bulk import of the ESCO (~13k) / O*NET / NCO
 * databases, and it deliberately assigns NO official source codes it cannot verify. The
 * full bulk import (official source files) is a follow-up that seeds through the SAME
 * loader. The RVM Hinglish shop-floor wedge (kharad/chhilai/…) + its aliases are TAX-5,
 * NOT here.
 *
 * INVARIANTS: `skillId` is IMMUTABLE and never reused (ADR-0030 SG-5). The 9 legacy
 * `skill_*` placeholder ids from `index.ts` are preserved verbatim ("existing ids must
 * remain stable"). `taxonomyVersion` bumps on any additive change; a re-tag never renames.
 */

/** Provenance of a canonical skill / alias (must match the DB `SkillSource`). */
export type SkillSource = "esco" | "onet" | "nco" | "rvm";
/** Lifecycle (must match the DB `SkillStatus`). */
export type SkillStatus = "active" | "provisional" | "deprecated";

/** Bump on every additive change to the corpus (ADR-0030 versioning). */
export const SKILL_TAXONOMY_VERSION = 1;

/** A source-provided alias (label variant) — English/standard variants only in TAX-2. */
export interface SkillAliasSeed {
  text: string;
  lang: "en" | "hi";
  source: SkillSource;
}

/** One canonical skill in the closed, immutable id space. */
export interface SkillSeed {
  skillId: string;
  labelEn: string;
  labelHi: string | null;
  domainId: string;
  source: SkillSource;
  status: SkillStatus;
  /** TAX-9 crosswalk: the immutable successor id — ONLY valid with status 'deprecated'
   * (deprecated-without-successor = retired, nothing to re-tag to). Ids are never
   * reused/renamed (SG-5); deprecation lives HERE (the reviewed source of truth), the
   * seed upserts it, and `pnpm db:retag:skills` re-tags affected rows OFFLINE. */
  replacedBy?: string;
  aliases: SkillAliasSeed[];
}

/**
 * Skill domains — the `skill.domain_id` scope for the domain-scoped ANN search
 * (ADR-0030). Slug-style, distinct from the `dom_*` occupation domains in `index.ts`.
 */
export const SKILL_DOMAINS = [
  { id: "cnc-machining", name: "CNC Machining" },
  { id: "vmc-machining", name: "VMC Machining" },
  { id: "grinding", name: "Grinding" },
  { id: "cnc-programming", name: "CNC / CAM Programming" },
  { id: "metrology-quality", name: "Metrology & Quality" },
  { id: "welding", name: "Welding" },
  { id: "fabrication", name: "Sheet-metal & Fabrication" },
  { id: "fitting-assembly", name: "Fitting & Assembly" },
  { id: "maintenance", name: "Machine Maintenance" },
  { id: "general-machining", name: "General Machining (occupation anchor)" },
] as const;

export type SkillDomainId = (typeof SKILL_DOMAINS)[number]["id"];

const en = (text: string, source: SkillSource): SkillAliasSeed => ({ text, lang: "en", source });

/**
 * The curated starter corpus.
 *
 * `source` records the pillar a concept derives from: `rvm` = the 9 first-party legacy
 * placeholders (preserved); `onet` = tool/machine/technology depth; `esco` = the skills
 * skeleton; `nco` = India occupation-name anchors. No official ESCO/O*NET/NCO numeric
 * codes are asserted (our `skill_id` is the authority — ADR-0030).
 */
export const SKILL_CORPUS: readonly SkillSeed[] = [
  // ---- Legacy placeholders (index.ts SKILLS) — ids preserved verbatim, source=rvm ----
  {
    skillId: "skill_gdt_reading",
    labelEn: "GD&T / drawing reading",
    labelHi: null,
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
    aliases: [
      en("drawing reading", "rvm"),
      en("GD&T", "rvm"),
      en("geometric dimensioning and tolerancing", "esco"),
      en("blueprint reading", "onet"),
    ],
  },
  {
    skillId: "skill_tool_offset_setting",
    labelEn: "Tool offset setting",
    labelHi: null,
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
    aliases: [en("tool offset", "rvm"), en("offset setting", "rvm")],
  },
  {
    skillId: "skill_program_editing",
    labelEn: "Program editing (G & M codes)",
    labelHi: null,
    domainId: "cnc-programming",
    source: "rvm",
    status: "active",
    aliases: [en("G-code editing", "rvm"), en("M-code", "rvm"), en("program editing", "onet")],
  },
  {
    skillId: "skill_fanuc",
    labelEn: "Fanuc control operation",
    labelHi: null,
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
    aliases: [en("Fanuc", "rvm"), en("Fanuc controller", "onet")],
  },
  {
    skillId: "skill_siemens",
    labelEn: "Siemens control operation",
    labelHi: null,
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
    aliases: [en("Siemens", "rvm"), en("Sinumerik", "onet")],
  },
  {
    skillId: "skill_mitsubishi",
    labelEn: "Mitsubishi control operation",
    labelHi: null,
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
    aliases: [en("Mitsubishi", "rvm"), en("Mitsubishi controller", "onet")],
  },
  {
    skillId: "skill_measuring_instruments",
    labelEn: "Micrometer / Vernier / gauge usage",
    labelHi: null,
    domainId: "metrology-quality",
    source: "rvm",
    status: "active",
    aliases: [
      en("micrometer", "onet"),
      en("vernier caliper", "onet"),
      en("gauge", "rvm"),
      en("measuring instruments", "esco"),
    ],
  },
  {
    skillId: "skill_fixture_setup",
    labelEn: "Fixture / job setup",
    labelHi: null,
    domainId: "cnc-machining",
    source: "rvm",
    status: "active",
    aliases: [en("fixture setup", "rvm"), en("job setup", "rvm"), en("workholding", "onet")],
  },
  {
    skillId: "skill_cam_software",
    labelEn: "CAM software (Mastercam/Fusion/etc.)",
    labelHi: null,
    domainId: "cnc-programming",
    source: "rvm",
    status: "active",
    aliases: [en("Mastercam", "onet"), en("Fusion 360", "onet"), en("CAM software", "esco")],
  },

  // ---- O*NET tool/machine depth — core machining operations ----
  {
    skillId: "skill_turning",
    labelEn: "Turning (lathe operation)",
    labelHi: null,
    domainId: "cnc-machining",
    source: "onet",
    status: "active",
    aliases: [en("turning", "onet"), en("lathe operation", "onet"), en("CNC turning", "onet")],
  },
  {
    skillId: "skill_milling",
    labelEn: "Milling",
    labelHi: null,
    domainId: "vmc-machining",
    source: "onet",
    status: "active",
    aliases: [en("milling", "onet"), en("CNC milling", "onet"), en("VMC operation", "onet")],
  },
  {
    skillId: "skill_drilling",
    labelEn: "Drilling",
    labelHi: null,
    domainId: "cnc-machining",
    source: "onet",
    status: "active",
    aliases: [en("drilling", "onet")],
  },
  {
    skillId: "skill_boring",
    labelEn: "Boring",
    labelHi: null,
    domainId: "cnc-machining",
    source: "onet",
    status: "active",
    aliases: [en("boring", "onet")],
  },
  {
    skillId: "skill_tapping_threading",
    labelEn: "Tapping / threading",
    labelHi: null,
    domainId: "cnc-machining",
    source: "onet",
    status: "active",
    aliases: [en("tapping", "onet"), en("threading", "onet")],
  },
  {
    skillId: "skill_grinding_ops",
    labelEn: "Grinding (surface / cylindrical)",
    labelHi: null,
    domainId: "grinding",
    source: "onet",
    status: "active",
    aliases: [
      en("grinding", "onet"),
      en("surface grinding", "onet"),
      en("cylindrical grinding", "onet"),
    ],
  },
  {
    skillId: "skill_deburring",
    labelEn: "Deburring / finishing",
    labelHi: null,
    domainId: "fabrication",
    source: "onet",
    status: "active",
    aliases: [en("deburring", "onet"), en("finishing", "onet")],
  },

  // ---- ESCO skills skeleton — programming, quality, mechanical ----
  {
    skillId: "skill_cnc_programming",
    labelEn: "CNC programming",
    labelHi: null,
    domainId: "cnc-programming",
    source: "esco",
    status: "active",
    aliases: [en("CNC programming", "esco"), en("part programming", "onet")],
  },
  {
    skillId: "skill_cad_interpretation",
    labelEn: "CAD / technical drawing interpretation",
    labelHi: null,
    domainId: "cnc-programming",
    source: "esco",
    status: "active",
    aliases: [en("CAD", "esco"), en("technical drawing", "esco"), en("read engineering drawings", "esco")],
  },
  {
    skillId: "skill_dimensional_inspection",
    labelEn: "Dimensional inspection",
    labelHi: null,
    domainId: "metrology-quality",
    source: "esco",
    status: "active",
    aliases: [en("inspection", "esco"), en("dimensional inspection", "esco"), en("quality check", "esco")],
  },
  {
    skillId: "skill_cmm",
    labelEn: "CMM operation",
    labelHi: null,
    domainId: "metrology-quality",
    source: "onet",
    status: "active",
    aliases: [en("CMM", "onet"), en("coordinate measuring machine", "onet")],
  },
  {
    skillId: "skill_quality_control",
    labelEn: "Quality control (QC)",
    labelHi: null,
    domainId: "metrology-quality",
    source: "esco",
    status: "active",
    aliases: [en("QC", "esco"), en("quality control", "esco")],
  },

  // ---- Adjacent trades — welding & fabrication (O*NET / ESCO) ----
  {
    skillId: "skill_mig_welding",
    labelEn: "MIG welding",
    labelHi: null,
    domainId: "welding",
    source: "onet",
    status: "active",
    aliases: [en("MIG welding", "onet"), en("GMAW", "onet"), en("MIG/MAG", "onet")],
  },
  {
    skillId: "skill_tig_welding",
    labelEn: "TIG welding",
    labelHi: null,
    domainId: "welding",
    source: "onet",
    status: "active",
    aliases: [en("TIG welding", "onet"), en("GTAW", "onet")],
  },
  {
    skillId: "skill_arc_welding",
    labelEn: "Arc welding",
    labelHi: null,
    domainId: "welding",
    source: "onet",
    status: "active",
    aliases: [en("arc welding", "onet"), en("SMAW", "onet"), en("stick welding", "onet")],
  },
  {
    skillId: "skill_gas_cutting",
    labelEn: "Gas cutting",
    labelHi: null,
    domainId: "fabrication",
    source: "onet",
    status: "active",
    aliases: [en("gas cutting", "onet"), en("oxy-fuel cutting", "onet")],
  },
  {
    skillId: "skill_sheet_metal",
    labelEn: "Sheet-metal fabrication",
    labelHi: null,
    domainId: "fabrication",
    source: "esco",
    status: "active",
    aliases: [en("sheet metal", "esco"), en("fabrication", "esco")],
  },

  // ---- Fitting, assembly, maintenance (ESCO) ----
  {
    skillId: "skill_bench_fitting",
    labelEn: "Bench fitting",
    labelHi: null,
    domainId: "fitting-assembly",
    source: "esco",
    status: "active",
    aliases: [en("fitting", "esco"), en("bench fitting", "esco")],
  },
  {
    skillId: "skill_mechanical_assembly",
    labelEn: "Mechanical assembly",
    labelHi: null,
    domainId: "fitting-assembly",
    source: "esco",
    status: "active",
    aliases: [en("assembly", "esco"), en("mechanical assembly", "esco")],
  },
  {
    skillId: "skill_hydraulics_pneumatics",
    labelEn: "Hydraulics / pneumatics",
    labelHi: null,
    domainId: "maintenance",
    source: "esco",
    status: "active",
    aliases: [en("hydraulics", "esco"), en("pneumatics", "esco")],
  },
  {
    skillId: "skill_machine_maintenance",
    labelEn: "Machine maintenance",
    labelHi: null,
    domainId: "maintenance",
    source: "esco",
    status: "active",
    aliases: [en("maintenance", "esco"), en("preventive maintenance", "esco")],
  },

  // ---- NCO-2015 India occupation-name anchors (occupation names, not skill codes) ----
  {
    skillId: "skill_machinist_occupation",
    labelEn: "Machinist (machine tool operator)",
    labelHi: null,
    domainId: "general-machining",
    source: "nco",
    status: "active",
    aliases: [en("machinist", "nco"), en("machine tool operator", "nco")],
  },
  {
    skillId: "skill_welder_occupation",
    labelEn: "Welder",
    labelHi: null,
    domainId: "welding",
    source: "nco",
    status: "active",
    aliases: [en("welder", "nco")],
  },
  {
    skillId: "skill_fitter_occupation",
    labelEn: "Fitter",
    labelHi: null,
    domainId: "fitting-assembly",
    source: "nco",
    status: "active",
    aliases: [en("fitter", "nco")],
  },
] as const;

const DOMAIN_IDS = new Set<string>(SKILL_DOMAINS.map((d) => d.id));
const SOURCES = new Set<SkillSource>(["esco", "onet", "nco", "rvm"]);
const STATUSES = new Set<SkillStatus>(["active", "provisional", "deprecated"]);

/**
 * Validate the corpus (deterministic, pure). Returns the list of problems — empty means
 * valid. Guards: unique skill_ids, every domain_id in SKILL_DOMAINS, valid source/status.
 * The seed loader and the tests both call this so an invalid corpus never seeds.
 */
export function validateSkillCorpus(corpus: readonly SkillSeed[] = SKILL_CORPUS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of corpus) {
    if (seen.has(s.skillId)) problems.push(`duplicate skill_id: ${s.skillId}`);
    seen.add(s.skillId);
    if (!DOMAIN_IDS.has(s.domainId)) problems.push(`${s.skillId}: unknown domain_id ${s.domainId}`);
    if (!SOURCES.has(s.source)) problems.push(`${s.skillId}: invalid source ${s.source}`);
    if (!STATUSES.has(s.status)) problems.push(`${s.skillId}: invalid status ${s.status}`);
    if (!s.labelEn.trim()) problems.push(`${s.skillId}: empty label_en`);
    for (const a of s.aliases) {
      if (!a.text.trim()) problems.push(`${s.skillId}: empty alias text`);
      if (!SOURCES.has(a.source)) problems.push(`${s.skillId}: alias invalid source ${a.source}`);
    }
  }
  // TAX-9 crosswalk discipline (mirrors the DB CHECK + FK): replacedBy only on a
  // deprecated skill, must point at a DIFFERENT corpus skill, and must not be cyclic
  // (chains A→B→C are legal; the retag runner resolves to the terminal id).
  for (const s of corpus) {
    if (s.replacedBy === undefined) continue;
    if (s.status !== "deprecated") {
      problems.push(`${s.skillId}: replacedBy set but status is ${s.status} (must be deprecated)`);
    }
    if (s.replacedBy === s.skillId) problems.push(`${s.skillId}: replacedBy points at itself`);
    if (!seen.has(s.replacedBy)) {
      problems.push(`${s.skillId}: replacedBy targets unknown skill_id ${s.replacedBy}`);
    }
  }
  const successor = new Map(
    corpus.filter((s) => s.replacedBy !== undefined).map((s) => [s.skillId, s.replacedBy as string]),
  );
  for (const start of successor.keys()) {
    let cur: string | undefined = start;
    const hops = new Set<string>();
    while (cur !== undefined && successor.has(cur)) {
      if (hops.has(cur)) {
        problems.push(`replacedBy cycle involving ${start}`);
        break;
      }
      hops.add(cur);
      cur = successor.get(cur);
    }
  }
  return problems;
}

/** The 9 legacy placeholder ids that MUST remain present + stable (ADR-0030 SG-5). */
export const LEGACY_SKILL_IDS = [
  "skill_gdt_reading",
  "skill_tool_offset_setting",
  "skill_program_editing",
  "skill_fanuc",
  "skill_siemens",
  "skill_mitsubishi",
  "skill_measuring_instruments",
  "skill_fixture_setup",
  "skill_cam_software",
] as const;

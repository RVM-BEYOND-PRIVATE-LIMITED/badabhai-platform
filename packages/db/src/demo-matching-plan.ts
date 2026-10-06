/**
 * Matching V1 stakeholder DEMO — the PURE plan (no database, no env, no IO).
 *
 * `seed-demo-matching.ts` is the writer; this module decides EVERY row it writes, so the unit
 * test (`demo-matching-plan.test.ts`) asserts exactly what the writer persists. Determinism
 * follows `reach-pool-data.ts`: one mulberry32 stream consumed in a fixed order, ids derived
 * from (kind, index), no `Math.random`, no wall clock (time is an injected `anchor`).
 *
 * WHAT THE DEMO MUST PROVE: with `MATCH_V1_ENABLED=true` each persona's feed carries ONLY the
 * jobs their wanted skills reach. So the persona mix is designed, not sampled: every persona
 * has (a) postings that name a skill they want (tier 1), (b) postings that name only a
 * RELATED skill (tier 2 — genuine `skill_related` edges from `@badabhai/taxonomy`), and
 * (c) a large hidden set (other trades). {@link personaExpectation} computes that split from
 * the plan alone so the plan test can fail before any database is involved.
 *
 * VOCABULARY LIMIT (2026-10-05): the match vocabulary is 18 `mskill_*` ids and has NO
 * electrician, press, coating or polymer skill. The Manesar showcase is therefore a FITTER, and
 * those role kinds post a flagged PROXY skill (see {@link DemoTrade}). Closing the gap is a
 * taxonomy change, not a seed change.
 *
 * TEXT: every worker-visible field (title, area, city, description, benefit and requirement
 * chips) is screened by the writer with `workerVisibleTextScreens` before any row is written,
 * and by the plan test. No phones, emails, company names or links.
 */
import { MATCH_SKILLS, matchSkillIndustry, relatedMatchSkills } from "@badabhai/taxonomy";
import type { TradeFormKindName } from "@badabhai/types";

import { makeRng, pickWeighted, type Rng } from "./reach-pool-data";

// ---------------------------------------------------------------------------
// Namespaced ids + reserved phones
// ---------------------------------------------------------------------------

/**
 * Every demo row id is `de30<KK>00-0000-4000-8000-<index as 12 hex>`. "de30" reads "demo";
 * KK keeps kinds disjoint. Distinct from the reach seed (`5eed…`) and the E4 fixture
 * (`e4f18440…`). `--unseed` deletes by {@link demoIdLikePattern}, never a blanket delete.
 */
export const DEMO_ID_PREFIX = "de30";

const KIND_TAG = {
  payer: "10",
  worker: "20",
  profile: "21",
  consent: "22",
  posting: "30",
} as const;

export type DemoIdKind = keyof typeof KIND_TAG;

export function demoUuid(kind: DemoIdKind, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`demoUuid: bad index ${index}`);
  return `${DEMO_ID_PREFIX}${KIND_TAG[kind]}00-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** SQL `LIKE` pattern matching every demo id of one kind (and nothing else). */
export function demoIdLikePattern(kind: DemoIdKind): string {
  return `${DEMO_ID_PREFIX}${KIND_TAG[kind]}00-0000-4000-8000-%`;
}

/**
 * The reserved synthetic range the local/staging test-login seam serves
 * (`SYNTHETIC_TEST_PHONE_PATTERN`, apps/api/src/auth/auth.dto.ts): `+91` + five zeros + five
 * digits. Re-declared (packages/db must not import apps/api) and pinned by the plan test.
 */
export const RESERVED_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/;

/** Demo phones: `+910000026001` … (block 26xxx of the reserved range; E4 uses 19844). */
export function demoPhone(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 998) {
    throw new Error(`demoPhone: index ${index} outside 0..998`);
  }
  return `+910000026${String(index + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------------

export interface DemoCity {
  /** Stored in `job_postings.city` / `workers.current_city` (the feed's city filter is case-insensitive). */
  name: string;
  slug: string;
  areas: readonly string[];
}

export const DEMO_CITIES: readonly DemoCity[] = [
  { name: "Pune", slug: "pune", areas: ["Chakan", "Bhosari", "Pimpri", "Ranjangaon", "Talegaon"] },
  {
    name: "Manesar",
    slug: "manesar",
    areas: ["IMT Manesar", "Sector 8 Manesar", "Binola", "Bilaspur Chowk", "Udyog Vihar"],
  },
  {
    name: "Chennai",
    slug: "chennai",
    areas: ["Sriperumbudur", "Ambattur", "Oragadam", "Guindy", "Maraimalai Nagar"],
  },
  {
    name: "Ahmedabad",
    slug: "ahmedabad",
    areas: ["Sanand", "Changodar", "Naroda", "Vatva", "Odhav"],
  },
  {
    name: "Bengaluru",
    slug: "bengaluru",
    areas: ["Peenya", "Bommasandra", "Jigani", "Whitefield", "Electronic City"],
  },
];

function cityByName(name: string): DemoCity {
  const c = DEMO_CITIES.find((x) => x.name === name);
  if (!c) throw new Error(`unknown demo city ${name}`);
  return c;
}

// ---------------------------------------------------------------------------
// Trade catalogue — VARIANTS keyed by the 21 declared role kinds
// ---------------------------------------------------------------------------

/**
 * One posting archetype. `roleKind` is the worker-side role (`job_postings.role_kind`, the
 * 21-kind `TRADE_FORM_KINDS_ALL` vocabulary — card illustrations key on it); `skillId` is the
 * ONE match skill it posts. Every kind has at least one variant, so every kind gets postings.
 *
 * THE MATCH SKILL IS CHOSEN FROM WHAT ONBOARDING ACTUALLY DERIVES (traced 2026-10-06):
 *   - chat (mock keyword extractor and real extraction): "welder"/"welding" → `role_welder` →
 *     `mskill_mig_welder`; "CNC turner" → `mskill_cnc_turner`; "CNC operator" →
 *     `mskill_cnc_operator_general`; vmc/hmc/setter/programmer/cam/grinding roles → their own
 *     match skill (`ROLE_TO_MATCH_SKILL`, packages/taxonomy/src/match-skills.ts);
 *   - trade form: only `qp_cnc_turning` bridges (`PACK_ATTRIBUTE_SKILLS`) → `mskill_cnc_turner`
 *     (+ programmer / cam by `programming_level`). The other 20 forms derive NOTHING today.
 * So `welder` postings are mostly MIG (what a live welder holds), and `cnc_turner` postings name
 * `mskill_cnc_turner`.
 *
 * PROXIES. The match vocabulary has 18 skills and no electrician, press, coating or polymer
 * skill. Those kinds still need postings (illustrations), and D5 skips a posting with no match
 * skill, so they post the NEAREST match skill and are flagged `proxy: true`. A proxy posting
 * reaches workers of the proxied skill (e.g. an electrician posting reaches fitters) — that is
 * disclosed by `--report-trades` and the runbook, and is the honest cost of the vocabulary gap.
 */
export interface DemoTrade {
  roleKind: TradeFormKindName;
  skillId: string;
  proxy: boolean;
  /** Relative posting volume. */
  weight: number;
  titles: readonly string[];
  /** Monthly pay floor band [lo, hi] in INR; the posting's pay_min is drawn from it. */
  pay: readonly [number, number];
  /** Range the posting's min_experience_years is drawn from. */
  minExp: readonly [number, number];
  /** Where the work happens — used in the description ("… at a {unit} in {area}"). */
  unit: string;
  requirements: readonly string[];
  /** Shifts this trade is posted with, weighted [day, rotational, night]. */
  shiftWeights: readonly [number, number, number];
}

const MACHINE_SHOP = "precision machine shop";
const PLANT = "auto components plant";
const PLASTICS = "plastics moulding plant";
const MACHINING_SHIFTS = [5, 4, 1] as const;

export const DEMO_TRADES: readonly DemoTrade[] = [
  // ── machining ──
  {
    roleKind: "cnc_turner",
    skillId: "mskill_cnc_turner",
    proxy: false,
    weight: 9,
    titles: ["CNC Turner", "CNC Lathe Operator", "CNC Turning Operator"],
    pay: [16000, 26000],
    minExp: [0, 4],
    unit: MACHINE_SHOP,
    requirements: [
      "Can read drawings",
      "Vernier and micrometer use",
      "Fanuc or Siemens control",
      "Tool offset setting",
    ],
    shiftWeights: MACHINING_SHIFTS,
  },
  {
    roleKind: "cnc_turner",
    skillId: "mskill_cnc_setter_operator",
    proxy: false,
    weight: 4,
    titles: ["CNC Setter cum Operator", "CNC Turning Setter"],
    pay: [22000, 34000],
    minExp: [2, 6],
    unit: MACHINE_SHOP,
    requirements: [
      "Program editing",
      "Tool and fixture setting",
      "First piece approval",
      "Fanuc or Siemens control",
    ],
    shiftWeights: MACHINING_SHIFTS,
  },
  {
    roleKind: "vmc_milling",
    skillId: "mskill_vmc_operator",
    proxy: false,
    weight: 8,
    titles: ["VMC Operator", "VMC Machine Operator", "VMC Milling Operator"],
    pay: [16000, 25000],
    minExp: [0, 4],
    unit: MACHINE_SHOP,
    requirements: [
      "Job loading and unloading",
      "Basic G code",
      "Height gauge and bore gauge",
      "Fanuc control",
    ],
    shiftWeights: MACHINING_SHIFTS,
  },
  {
    roleKind: "vmc_milling",
    skillId: "mskill_hmc_operator",
    proxy: false,
    weight: 4,
    titles: ["HMC Operator", "HMC Machine Operator"],
    pay: [18000, 28000],
    minExp: [1, 4],
    unit: MACHINE_SHOP,
    requirements: ["Pallet changing", "Fixture setting", "Basic G code", "Inspection with gauges"],
    shiftWeights: [4, 5, 1],
  },
  {
    roleKind: "cnc_grinding",
    skillId: "mskill_cnc_grinding_operator",
    proxy: false,
    weight: 3,
    titles: ["CNC Grinding Operator", "Cylindrical Grinding Operator"],
    pay: [16000, 26000],
    minExp: [1, 4],
    unit: MACHINE_SHOP,
    requirements: [
      "Cylindrical or centreless grinding",
      "Micron level measuring",
      "Wheel dressing",
    ],
    shiftWeights: MACHINING_SHIFTS,
  },
  {
    roleKind: "conventional_machinist",
    skillId: "mskill_cnc_operator_general",
    proxy: false,
    weight: 4,
    titles: ["CNC Operator", "Lathe Machinist", "Machine Operator Trainee"],
    pay: [13000, 20000],
    minExp: [0, 2],
    unit: "machining unit",
    requirements: [
      "ITI Machinist or Turner",
      "Job loading",
      "Basic measuring",
      "Willing to learn setting",
    ],
    shiftWeights: MACHINING_SHIFTS,
  },
  {
    roleKind: "tool_die_maker",
    skillId: "mskill_cnc_setter_operator",
    proxy: true,
    weight: 2,
    titles: ["Tool Room Machinist", "Tool and Die Maker"],
    pay: [22000, 34000],
    minExp: [2, 6],
    unit: "tool room",
    requirements: ["Press tool fitting", "Surface grinding", "Can read tool drawings"],
    shiftWeights: [8, 2, 0],
  },
  // ── design desk ──
  {
    roleKind: "cam_programmer",
    skillId: "mskill_cam_programmer",
    proxy: false,
    weight: 2,
    titles: ["CAM Programmer", "Mastercam Programmer"],
    pay: [30000, 45000],
    minExp: [2, 5],
    unit: "tool room",
    requirements: ["Mastercam or NX CAM", "3 axis and 4 axis toolpaths", "Post processor basics"],
    shiftWeights: [9, 1, 0],
  },
  {
    roleKind: "cam_programmer",
    skillId: "mskill_cnc_programmer",
    proxy: false,
    weight: 3,
    titles: ["CNC Programmer", "CNC Programmer cum Setter"],
    pay: [28000, 42000],
    minExp: [3, 6],
    unit: MACHINE_SHOP,
    requirements: [
      "Manual G and M code",
      "Fanuc and Siemens",
      "Cycle time reduction",
      "Can read GD&T drawings",
    ],
    shiftWeights: [8, 2, 0],
  },
  {
    roleKind: "cad_draughtsman",
    skillId: "mskill_designer",
    proxy: false,
    weight: 2,
    titles: ["Mechanical Design Draughtsman", "CAD Designer"],
    pay: [22000, 36000],
    minExp: [0, 4],
    unit: "design office",
    requirements: ["AutoCAD", "SolidWorks or Creo", "Detail drawings", "Bill of materials"],
    shiftWeights: [10, 0, 0],
  },
  {
    roleKind: "cad_draughtsman",
    skillId: "mskill_interior_designer",
    proxy: false,
    weight: 1,
    titles: ["Interior Design Draughtsman", "Interior Site Designer"],
    pay: [20000, 32000],
    minExp: [1, 4],
    unit: "interior fit-out firm",
    requirements: ["AutoCAD layouts", "Site measurement", "Modular furniture drawings"],
    shiftWeights: [10, 0, 0],
  },
  // ── fabrication ──
  {
    roleKind: "welder",
    skillId: "mskill_mig_welder",
    proxy: false,
    weight: 8,
    titles: ["Welder", "MIG Welder", "CO2 Welder"],
    pay: [16000, 25000],
    minExp: [0, 4],
    unit: "sheet metal fabrication shop",
    requirements: [
      "MIG or CO2 welding",
      "Sheet metal and MS",
      "Jig welding",
      "Grinding and finishing",
    ],
    shiftWeights: [6, 3, 1],
  },
  {
    roleKind: "welder",
    skillId: "mskill_arc_welder",
    proxy: false,
    weight: 5,
    titles: ["Arc Welder", "Stick Welder", "Fabrication Welder"],
    pay: [15000, 24000],
    minExp: [0, 4],
    unit: "fabrication shop",
    requirements: [
      "Arc welding on MS plates",
      "Fillet and butt joints",
      "Safety shoes and PPE use",
      "Can read welding symbols",
    ],
    shiftWeights: [6, 3, 1],
  },
  {
    roleKind: "welder",
    skillId: "mskill_tig_welder",
    proxy: false,
    weight: 4,
    titles: ["TIG Welder", "TIG Welder for SS and Aluminium", "Argon Welder"],
    pay: [18000, 30000],
    minExp: [1, 5],
    unit: "stainless steel fabrication shop",
    requirements: [
      "TIG on SS and aluminium",
      "Thin sheet welding",
      "Pipe welding",
      "Clean bead finish",
    ],
    shiftWeights: [6, 3, 1],
  },
  {
    roleKind: "sheet_metal_worker",
    skillId: "mskill_mig_welder",
    proxy: true,
    weight: 3,
    titles: ["Sheet Metal Fabricator", "Sheet Metal Worker"],
    pay: [15000, 23000],
    minExp: [0, 3],
    unit: "sheet metal fabrication shop",
    requirements: ["Bending and shearing", "Spot and MIG welding", "Measurement and marking"],
    shiftWeights: [6, 3, 1],
  },
  {
    roleKind: "press_operator",
    skillId: "mskill_cnc_operator_general",
    proxy: true,
    weight: 2,
    titles: ["Power Press Operator", "Press Shop Operator"],
    pay: [13000, 19000],
    minExp: [0, 2],
    unit: "press shop",
    requirements: ["Power press operation", "Die loading basics", "Safety guard discipline"],
    shiftWeights: [5, 4, 1],
  },
  {
    roleKind: "painter_coating",
    skillId: "mskill_cnc_operator_general",
    proxy: true,
    weight: 1,
    titles: ["Powder Coating Operator", "Spray Painter"],
    pay: [13000, 20000],
    minExp: [0, 3],
    unit: "powder coating line",
    requirements: ["Spray gun handling", "Surface preparation", "Coating thickness check"],
    shiftWeights: [6, 3, 1],
  },
  // ── maintenance & production ──
  {
    roleKind: "fitter",
    skillId: "mskill_fitter",
    proxy: false,
    weight: 6,
    titles: ["Maintenance Fitter", "Mechanical Fitter", "Assembly Fitter"],
    pay: [15000, 25000],
    minExp: [0, 4],
    unit: PLANT,
    requirements: [
      "ITI Fitter",
      "Preventive maintenance",
      "Bearing and gearbox fitting",
      "Hydraulics basics",
    ],
    shiftWeights: [5, 4, 1],
  },
  {
    roleKind: "fitter",
    skillId: "mskill_plumber",
    proxy: false,
    weight: 3,
    titles: ["Plumber", "Industrial Plumber", "Pipe Fitter"],
    pay: [14000, 22000],
    minExp: [0, 3],
    unit: "construction site",
    requirements: [
      "GI and CPVC pipe fitting",
      "Leak testing",
      "Drawing reading",
      "Own basic tools",
    ],
    shiftWeights: [9, 1, 0],
  },
  {
    roleKind: "maintenance_technician",
    skillId: "mskill_fitter",
    proxy: true,
    weight: 3,
    titles: ["Maintenance Technician", "Utility Maintenance Technician"],
    pay: [16000, 26000],
    minExp: [1, 4],
    unit: PLANT,
    requirements: [
      "Breakdown maintenance",
      "Compressor and pump upkeep",
      "Maintenance log keeping",
    ],
    shiftWeights: [4, 5, 1],
  },
  {
    roleKind: "industrial_electrician",
    skillId: "mskill_fitter",
    proxy: true,
    weight: 3,
    titles: ["Industrial Electrician", "Maintenance Electrician"],
    pay: [16000, 27000],
    minExp: [1, 4],
    unit: PLANT,
    requirements: [
      "ITI Electrician",
      "Panel wiring",
      "Motor and starter fault finding",
      "Safety lockout practice",
    ],
    shiftWeights: [4, 5, 1],
  },
  {
    roleKind: "assembly_line_worker",
    skillId: "mskill_fitter",
    proxy: true,
    weight: 2,
    titles: ["Assembly Line Operator", "Production Associate"],
    pay: [12000, 18000],
    minExp: [0, 1],
    unit: PLANT,
    requirements: ["Line assembly work", "Torque tool use", "Follows work instructions"],
    shiftWeights: [5, 4, 1],
  },
  {
    roleKind: "quality_inspector",
    skillId: "mskill_quality_inspector",
    proxy: false,
    weight: 5,
    titles: ["Quality Inspector", "QC Inspector", "Line Quality Inspector"],
    pay: [16000, 26000],
    minExp: [1, 4],
    unit: PLANT,
    requirements: [
      "Vernier, micrometer and height gauge",
      "Inspection reports",
      "PPAP and first piece basics",
      "Can read drawings",
    ],
    shiftWeights: [5, 4, 1],
  },
  // ── plastics & rubber (all proxies: no polymer match skill exists) ──
  {
    roleKind: "injection_moulding_operator",
    skillId: "mskill_cnc_operator_general",
    proxy: true,
    weight: 2,
    titles: ["Injection Moulding Operator", "Moulding Machine Operator"],
    pay: [13000, 20000],
    minExp: [0, 3],
    unit: PLASTICS,
    requirements: ["Mould loading", "Cycle monitoring", "Visual defect checks"],
    shiftWeights: [4, 5, 1],
  },
  {
    roleKind: "mould_die_maker",
    skillId: "mskill_cnc_setter_operator",
    proxy: true,
    weight: 1,
    titles: ["Mould Maker", "Mould Maintenance Fitter"],
    pay: [20000, 32000],
    minExp: [2, 5],
    unit: "tool room",
    requirements: ["Mould polishing and repair", "EDM basics", "Can read mould drawings"],
    shiftWeights: [8, 2, 0],
  },
  {
    roleKind: "blow_moulding_operator",
    skillId: "mskill_cnc_operator_general",
    proxy: true,
    weight: 1,
    titles: ["Blow Moulding Operator"],
    pay: [13000, 19000],
    minExp: [0, 2],
    unit: PLASTICS,
    requirements: ["Parison and mould setting basics", "Bottle quality checks"],
    shiftWeights: [4, 5, 1],
  },
  {
    roleKind: "rubber_moulding_operator",
    skillId: "mskill_cnc_operator_general",
    proxy: true,
    weight: 1,
    titles: ["Rubber Moulding Operator", "Compression Moulding Operator"],
    pay: [13000, 19000],
    minExp: [0, 2],
    unit: "rubber products plant",
    requirements: ["Compression press operation", "Deflashing", "Visual defect checks"],
    shiftWeights: [4, 5, 1],
  },
  {
    roleKind: "plastic_process_technician",
    skillId: "mskill_cnc_operator_general",
    proxy: true,
    weight: 1,
    titles: ["Plastic Process Technician"],
    pay: [18000, 28000],
    minExp: [1, 4],
    unit: PLASTICS,
    requirements: ["Process parameter setting", "Mould trials", "Scrap reduction"],
    shiftWeights: [5, 4, 1],
  },
];

export const DEMO_BENEFITS: readonly string[] = [
  "PF and ESI",
  "Canteen food",
  "Company transport",
  "Overtime pay",
  "Room and stay support",
  "Uniform and safety shoes",
  "Yearly bonus",
  "Medical insurance",
  "Weekly off",
  "Attendance incentive",
];

// ---------------------------------------------------------------------------
// Personas — designed, not sampled (fallback + side-by-side for the LIVE onboarding demo)
// ---------------------------------------------------------------------------

export interface DemoPersonaSkill {
  skillId: string;
  /** `worker_skill.months_bucketed` (6-month buckets, the engine's convention). */
  months: number;
}

export interface DemoPersonaSpec {
  key: string;
  /** SYNTHETIC display name — written ONLY into `workers.full_name`, encrypted. */
  name: string;
  city: string;
  showcase: boolean;
  /** One-line story the presenter tells. */
  story: string;
  skills: readonly DemoPersonaSkill[];
}

/** The owner's cap: the live chat is the main path; personas are the fallback. */
export const MAX_DEMO_PERSONAS = 10;

/**
 * Showcases FIRST, so a small profile (`--personas=5`) always contains both. Skill sets mirror
 * what onboarding derives, so a persona sits next to a live-created worker of the same trade
 * and the two feeds can be compared: the welder holds `mskill_mig_welder` (what "welder" in the
 * chat yields), the turner `mskill_cnc_turner`, the CNC operator `mskill_cnc_operator_general`.
 * Every persona holds a skill with `skill_related` neighbours it does not itself want, which
 * guarantees a non-empty related-only set.
 */
export const DEMO_PERSONAS: readonly DemoPersonaSpec[] = [
  {
    key: "showcase-welder-pune",
    name: "Ravi Demo",
    city: "Pune",
    showcase: true,
    story:
      "Welder, 4 years (what the chat derives for 'welder': MIG). Arc and TIG jobs arrive as related; no machining, plastics or design jobs.",
    skills: [{ skillId: "mskill_mig_welder", months: 48 }],
  },
  {
    key: "showcase-fitter-manesar",
    name: "Suresh Demo",
    city: "Manesar",
    showcase: true,
    story:
      "Maintenance fitter, 5 years. Plumbing and QC jobs arrive as related. (Electrician postings are a fitter proxy — no electrician match skill exists.)",
    skills: [{ skillId: "mskill_fitter", months: 60 }],
  },
  {
    key: "cnc-turner-pune",
    name: "Amit Demo",
    city: "Pune",
    showcase: false,
    story:
      "CNC turner, 3 years (what the chat and the turning form derive). VMC, setter, grinding and general CNC jobs arrive as related.",
    skills: [{ skillId: "mskill_cnc_turner", months: 36 }],
  },
  {
    key: "cnc-operator-ahmedabad",
    name: "Bhavesh Demo",
    city: "Ahmedabad",
    showcase: false,
    story:
      "CNC operator, 1 year (what the chat derives for 'CNC operator'). Grinding, turner and HMC jobs are related.",
    skills: [{ skillId: "mskill_cnc_operator_general", months: 12 }],
  },
  {
    key: "plumber-ahmedabad",
    name: "Jignesh Demo",
    city: "Ahmedabad",
    showcase: false,
    story: "Plumber, 3 years. Fitter jobs arrive as related.",
    skills: [{ skillId: "mskill_plumber", months: 36 }],
  },
  {
    key: "tig-arc-welder-bengaluru",
    name: "Manjunath Demo",
    city: "Bengaluru",
    showcase: false,
    story: "TIG welder who also does arc. MIG jobs are related.",
    skills: [
      { skillId: "mskill_tig_welder", months: 72 },
      { skillId: "mskill_arc_welder", months: 12 },
    ],
  },
  {
    key: "vmc-hmc-chennai",
    name: "Karthik Demo",
    city: "Chennai",
    showcase: false,
    story: "VMC operator with some HMC. Setter, turner and general CNC jobs are related.",
    skills: [
      { skillId: "mskill_vmc_operator", months: 24 },
      { skillId: "mskill_hmc_operator", months: 12 },
    ],
  },
  {
    key: "qc-inspector-bengaluru",
    name: "Lakshmi Demo",
    city: "Bengaluru",
    showcase: false,
    story: "Quality inspector, 2 years. Fitter jobs are related.",
    skills: [{ skillId: "mskill_quality_inspector", months: 24 }],
  },
  {
    key: "setter-chennai",
    name: "Murugan Demo",
    city: "Chennai",
    showcase: false,
    story: "CNC setter-operator, 4.5 years. Programmer, turner, HMC and VMC jobs are related.",
    skills: [{ skillId: "mskill_cnc_setter_operator", months: 54 }],
  },
  {
    key: "cam-programmer-pune",
    name: "Nikhil Demo",
    city: "Pune",
    showcase: false,
    story: "CAM programmer. CNC programmer and design jobs are related.",
    skills: [{ skillId: "mskill_cam_programmer", months: 30 }],
  },
];

// ---------------------------------------------------------------------------
// Payers
// ---------------------------------------------------------------------------

export const DEMO_PAYER_COUNT = 25;

export interface DemoPayer {
  index: number;
  payerId: string;
  /** SYNTHETIC — encrypted into `payers.org_name_enc`; never worker-visible. */
  orgName: string;
  /** SYNTHETIC — `.invalid` TLD (RFC 2606), encrypted + hashed. */
  email: string;
  /** Relative posting volume: a few large employers make the max-2 interleave visible. */
  weight: number;
}

export function buildDemoPayers(count: number = DEMO_PAYER_COUNT): DemoPayer[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return {
      index: i,
      payerId: demoUuid("payer", i),
      orgName: `Demo Employer ${n} (synthetic)`,
      email: `demo-employer-${n}@demo-matching.test.invalid`,
      // Employers 01-03 are large (weight 6), 04-08 medium (3), the rest small (1).
      weight: i < 3 ? 6 : i < 8 ? 3 : 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export type DemoShift = "day" | "rotational" | "night";
export type DemoPayType = "in_hand" | "gross" | "ctc";
export type DemoNeededBy = "immediate" | "soon" | "flexible";
export type DemoVacancyBand = "1" | "2-5" | "6-10" | "11-25" | "25+";

export interface DemoPosting {
  index: number;
  postingId: string;
  payerIndex: number;
  /** The POSTED skills (`match_skill_ids`). The reach set is resolved by the writer at publish rules. */
  matchSkillIds: string[];
  primarySkillId: string;
  /** `job_postings.role_kind` — one of the 21 declared kinds. */
  roleKind: TradeFormKindName;
  /** The kind has no match skill of its own; it posts the nearest one (see DemoTrade). */
  proxy: boolean;
  industryId: string;
  roleTitle: string;
  city: string;
  area: string;
  description: string;
  benefits: string[];
  requirements: string[];
  payMin: number;
  payMax: number;
  payType: DemoPayType | null;
  shift: DemoShift | null;
  neededBy: DemoNeededBy;
  vacancyBand: DemoVacancyBand;
  minExperienceYears: number;
  maxExperienceYears: number;
  /** Minutes BEFORE the anchor this posting was published (0 .. 30 days). */
  publishedMinutesAgo: number;
  boosted: boolean;
}

export const PUBLISH_WINDOW_MINUTES = 30 * 24 * 60;
/** Share of postings boosted. */
export const BOOST_RATE = 0.03;
/** Share of postings (after the coverage pass) that name a second, related skill. */
const TWO_SKILL_RATE = 0.15;

function pickOne<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng.next() * items.length)]!;
}

/** `k` distinct items, order preserved from the source list (stable output). */
function pickDistinct<T>(items: readonly T[], k: number, rng: Rng): T[] {
  const chosen = new Set<number>();
  while (chosen.size < Math.min(k, items.length)) chosen.add(Math.floor(rng.next() * items.length));
  return [...chosen].sort((a, b) => a - b).map((i) => items[i]!);
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function shiftLine(shift: DemoShift | null): string {
  switch (shift) {
    case "day":
      return "Day shift.";
    case "rotational":
      return "Rotational shifts.";
    case "night":
      return "Night shift, with night allowance.";
    default:
      return "Shift timing discussed at interview.";
  }
}

export function buildDemoPosting(
  index: number,
  payers: readonly DemoPayer[],
  rng: Rng,
): DemoPosting {
  // COVERAGE PASS: the first |trades| postings name each trade once, single-skill — so even a
  // tiny profile has a direct AND a related-only posting for every persona.
  const coverage = index < DEMO_TRADES.length;
  const trade = coverage
    ? DEMO_TRADES[index]!
    : pickWeighted(
        DEMO_TRADES,
        DEMO_TRADES.map((t) => t.weight),
        rng,
      );
  const matchSkillIds = [trade.skillId];
  const neighbours = relatedMatchSkills(trade.skillId);
  if (!coverage && !trade.proxy && neighbours.length > 0 && rng.next() < TWO_SKILL_RATE) {
    matchSkillIds.push(pickOne(neighbours, rng));
  }
  const industryId = matchSkillIndustry(trade.skillId);
  if (!industryId) throw new Error(`${trade.skillId} has no industry in the taxonomy`);

  const payerIndex = pickWeighted(
    payers.map((p) => p.index),
    payers.map((p) => p.weight),
    rng,
  );
  const city = pickOne(DEMO_CITIES, rng);
  const area = pickOne(city.areas, rng);
  const roleTitle = pickOne(trade.titles, rng);

  const [lo, hi] = trade.pay;
  const payMin = roundTo(lo + rng.next() * (hi - lo), 500);
  const payMax = payMin + roundTo(2000 + rng.next() * 8000, 500);
  const payType = pickWeighted<DemoPayType | null>(
    ["in_hand", "gross", "ctc", null],
    [0.5, 0.2, 0.15, 0.15],
    rng,
  );
  const shift = pickWeighted<DemoShift | null>(
    ["day", "rotational", "night", null],
    [...trade.shiftWeights, 1],
    rng,
  );
  const neededBy = pickWeighted<DemoNeededBy>(
    ["immediate", "soon", "flexible"],
    [0.4, 0.4, 0.2],
    rng,
  );
  const vacancyBand = pickWeighted<DemoVacancyBand>(
    ["1", "2-5", "6-10", "11-25", "25+"],
    [0.2, 0.4, 0.25, 0.1, 0.05],
    rng,
  );
  const [eLo, eHi] = trade.minExp;
  const minExperienceYears = eLo + Math.floor(rng.next() * (eHi - eLo + 1));
  const maxExperienceYears = minExperienceYears + 2 + Math.floor(rng.next() * 4);
  const benefits = pickDistinct(DEMO_BENEFITS, 2 + Math.floor(rng.next() * 3), rng);
  const requirements = pickDistinct(trade.requirements, 2 + Math.floor(rng.next() * 2), rng);
  const publishedMinutesAgo = Math.floor(rng.next() * PUBLISH_WINDOW_MINUTES);
  const boosted = rng.next() < BOOST_RATE;

  const description =
    `${roleTitle} needed at a ${trade.unit} in ${area}, ${city.name}. ` +
    `${minExperienceYears === 0 ? "Freshers welcome." : `${minExperienceYears}+ years of experience.`} ` +
    shiftLine(shift);

  return {
    index,
    postingId: demoUuid("posting", index),
    payerIndex,
    matchSkillIds,
    primarySkillId: trade.skillId,
    roleKind: trade.roleKind,
    proxy: trade.proxy,
    industryId,
    roleTitle,
    city: city.name,
    area,
    description,
    benefits,
    requirements,
    payMin,
    payMax,
    payType,
    shift,
    neededBy,
    vacancyBand,
    minExperienceYears,
    maxExperienceYears,
    publishedMinutesAgo,
    boosted,
  };
}

// ---------------------------------------------------------------------------
// Personas → rows
// ---------------------------------------------------------------------------

export interface DemoPersona extends DemoPersonaSpec {
  index: number;
  workerId: string;
  profileId: string;
  consentId: string;
  /** RESERVED synthetic phone (never real) — encrypted + hashed at rest. */
  phoneE164: string;
  citySlug: string;
  totalYears: number;
}

export function buildDemoPersonas(count: number): DemoPersona[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > Math.min(MAX_DEMO_PERSONAS, DEMO_PERSONAS.length)
  ) {
    throw new Error(
      `personas must be in 1..${Math.min(MAX_DEMO_PERSONAS, DEMO_PERSONAS.length)} (got ${count})`,
    );
  }
  return DEMO_PERSONAS.slice(0, count).map((spec, i) => ({
    ...spec,
    index: i,
    workerId: demoUuid("worker", i),
    profileId: demoUuid("profile", i),
    consentId: demoUuid("consent", i),
    phoneE164: demoPhone(i),
    citySlug: cityByName(spec.city).slug,
    totalYears: Math.max(1, Math.round(Math.max(...spec.skills.map((s) => s.months)) / 12)),
  }));
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface DemoPlanOptions {
  personas: number;
  postings: number;
  rngSeed: number;
}

export const DEFAULT_DEMO_PLAN: DemoPlanOptions = Object.freeze({
  personas: DEMO_PERSONAS.length,
  postings: 1200,
  rngSeed: 20261005,
});

export interface DemoPlan {
  options: DemoPlanOptions;
  payers: DemoPayer[];
  personas: DemoPersona[];
  postings: DemoPosting[];
}

export function buildDemoPlan(options: DemoPlanOptions = DEFAULT_DEMO_PLAN): DemoPlan {
  if (!Number.isInteger(options.postings) || options.postings < DEMO_TRADES.length) {
    throw new Error(
      `postings must be an integer >= ${DEMO_TRADES.length} (one per trade for coverage); got ${options.postings}`,
    );
  }
  const rng = makeRng(options.rngSeed);
  const payers = buildDemoPayers();
  const personas = buildDemoPersonas(options.personas);
  const postings = Array.from({ length: options.postings }, (_, i) =>
    buildDemoPosting(i, payers, rng),
  );
  return { options, payers, personas, postings };
}

/** Every worker-visible string a posting carries, with the field it came from. */
export function workerVisibleFields(p: DemoPosting): Array<[string, string]> {
  return [
    ["role_title", p.roleTitle],
    ["city", p.city],
    ["area", p.area],
    ["description", p.description],
    ...p.benefits.map((b, i): [string, string] => [`benefits[${i}]`, b]),
    ...p.requirements.map((r, i): [string, string] => [`requirements[${i}]`, r]),
  ];
}

/**
 * The PLAN-LEVEL expectation for one persona, given each posting's reach set. Pure, so the plan
 * test can prove the three-way split before any database exists, and the writer can cross-check
 * what D5 materialized against it.
 *
 *   direct       — the posting names a skill the persona wants (tier 1)
 *   relatedOnly  — it names none, but its reach set holds one (tier 2)
 *   hidden       — its reach set holds none
 */
export function personaExpectation(
  persona: Pick<DemoPersonaSpec, "skills">,
  postings: ReadonlyArray<{
    postingId: string;
    matchSkillIds: readonly string[];
    reachSkillIds: readonly string[];
  }>,
): { direct: string[]; relatedOnly: string[]; hidden: string[] } {
  const wants = new Set(persona.skills.map((s) => s.skillId));
  const out = { direct: [] as string[], relatedOnly: [] as string[], hidden: [] as string[] };
  for (const p of postings) {
    if (p.matchSkillIds.some((id) => wants.has(id))) out.direct.push(p.postingId);
    else if (p.reachSkillIds.some((id) => wants.has(id))) out.relatedOnly.push(p.postingId);
    else out.hidden.push(p.postingId);
  }
  return out;
}

/** The whole match vocabulary, for the coverage assertion (every trade is one match skill). */
export const MATCH_VOCABULARY_IDS: readonly string[] = MATCH_SKILLS.map((m) => m.skillId);

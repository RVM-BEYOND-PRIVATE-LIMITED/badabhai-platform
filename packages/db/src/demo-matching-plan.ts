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
 * electrician. The Manesar showcase is therefore a FITTER (maintenance trade, related to
 * plumber + quality inspector). Adding an electrician is a taxonomy change, not a seed change.
 *
 * TEXT: every worker-visible field (title, area, city, description, benefit and requirement
 * chips) is screened by the writer with `workerVisibleTextScreens` before any row is written,
 * and by the plan test. No phones, emails, company names or links.
 */
import { MATCH_SKILLS, matchSkillIndustry, relatedMatchSkills } from "@badabhai/taxonomy";

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
  { name: "Ahmedabad", slug: "ahmedabad", areas: ["Sanand", "Changodar", "Naroda", "Vatva", "Odhav"] },
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
// Trade catalogue — one entry per match skill (the WHOLE vocabulary: 18 ids)
// ---------------------------------------------------------------------------

export interface DemoTrade {
  skillId: string;
  /** Relative posting volume (the wedge trades are common, niche ones thin). */
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

export const DEMO_TRADES: readonly DemoTrade[] = [
  {
    skillId: "mskill_cnc_turner",
    weight: 9,
    titles: ["CNC Turner", "CNC Lathe Operator", "CNC Turning Operator"],
    pay: [16000, 26000],
    minExp: [0, 4],
    unit: MACHINE_SHOP,
    requirements: ["Can read drawings", "Vernier and micrometer use", "Fanuc or Siemens control", "Tool offset setting"],
    shiftWeights: [5, 4, 1],
  },
  {
    skillId: "mskill_vmc_operator",
    weight: 8,
    titles: ["VMC Operator", "VMC Machine Operator", "VMC Milling Operator"],
    pay: [16000, 25000],
    minExp: [0, 4],
    unit: MACHINE_SHOP,
    requirements: ["Job loading and unloading", "Basic G code", "Height gauge and bore gauge", "Fanuc control"],
    shiftWeights: [5, 4, 1],
  },
  {
    skillId: "mskill_hmc_operator",
    weight: 4,
    titles: ["HMC Operator", "HMC Machine Operator"],
    pay: [18000, 28000],
    minExp: [1, 4],
    unit: MACHINE_SHOP,
    requirements: ["Pallet changing", "Fixture setting", "Basic G code", "Inspection with gauges"],
    shiftWeights: [4, 5, 1],
  },
  {
    skillId: "mskill_cnc_operator_general",
    weight: 6,
    titles: ["CNC Operator", "CNC Machine Operator", "CNC Operator Trainee"],
    pay: [13000, 20000],
    minExp: [0, 2],
    unit: "machining unit",
    requirements: ["ITI Machinist or Turner", "Job loading", "Basic measuring", "Willing to learn setting"],
    shiftWeights: [5, 4, 1],
  },
  {
    skillId: "mskill_cnc_grinding_operator",
    weight: 3,
    titles: ["CNC Grinding Operator", "Cylindrical Grinding Operator"],
    pay: [16000, 26000],
    minExp: [1, 4],
    unit: MACHINE_SHOP,
    requirements: ["Cylindrical or centreless grinding", "Micron level measuring", "Wheel dressing"],
    shiftWeights: [5, 4, 1],
  },
  {
    skillId: "mskill_cnc_setter_operator",
    weight: 5,
    titles: ["CNC Setter cum Operator", "CNC Setter", "VMC Setter"],
    pay: [22000, 34000],
    minExp: [2, 6],
    unit: MACHINE_SHOP,
    requirements: ["Program editing", "Tool and fixture setting", "First piece approval", "Fanuc or Siemens control"],
    shiftWeights: [5, 4, 1],
  },
  {
    skillId: "mskill_cnc_programmer",
    weight: 3,
    titles: ["CNC Programmer", "CNC Programmer cum Setter"],
    pay: [28000, 42000],
    minExp: [3, 6],
    unit: MACHINE_SHOP,
    requirements: ["Manual G and M code", "Fanuc and Siemens", "Cycle time reduction", "Can read GD&T drawings"],
    shiftWeights: [8, 2, 0],
  },
  {
    skillId: "mskill_cam_programmer",
    weight: 2,
    titles: ["CAM Programmer", "Mastercam Programmer"],
    pay: [30000, 45000],
    minExp: [2, 5],
    unit: "tool room",
    requirements: ["Mastercam or NX CAM", "3 axis and 4 axis toolpaths", "Post processor basics"],
    shiftWeights: [9, 1, 0],
  },
  {
    skillId: "mskill_designer",
    weight: 2,
    titles: ["Mechanical Design Draughtsman", "CAD Designer"],
    pay: [22000, 36000],
    minExp: [1, 4],
    unit: "design office",
    requirements: ["AutoCAD", "SolidWorks or Creo", "Detail drawings", "Bill of materials"],
    shiftWeights: [10, 0, 0],
  },
  {
    skillId: "mskill_interior_designer",
    weight: 2,
    titles: ["Interior Design Draughtsman", "Interior Site Designer"],
    pay: [20000, 32000],
    minExp: [1, 4],
    unit: "interior fit-out firm",
    requirements: ["AutoCAD layouts", "Site measurement", "Modular furniture drawings"],
    shiftWeights: [10, 0, 0],
  },
  {
    skillId: "mskill_arc_welder",
    weight: 8,
    titles: ["Arc Welder", "Stick Welder", "Fabrication Welder"],
    pay: [15000, 24000],
    minExp: [0, 4],
    unit: "fabrication shop",
    requirements: ["Arc welding on MS plates", "Fillet and butt joints", "Safety shoes and PPE use", "Can read welding symbols"],
    shiftWeights: [6, 3, 1],
  },
  {
    skillId: "mskill_mig_welder",
    weight: 7,
    titles: ["MIG Welder", "CO2 Welder", "MIG Welding Operator"],
    pay: [16000, 25000],
    minExp: [0, 4],
    unit: "sheet metal fabrication shop",
    requirements: ["MIG or CO2 welding", "Sheet metal and MS", "Jig welding", "Grinding and finishing"],
    shiftWeights: [6, 3, 1],
  },
  {
    skillId: "mskill_tig_welder",
    weight: 5,
    titles: ["TIG Welder", "TIG Welder for SS and Aluminium", "Argon Welder"],
    pay: [18000, 30000],
    minExp: [1, 5],
    unit: "stainless steel fabrication shop",
    requirements: ["TIG on SS and aluminium", "Thin sheet welding", "Pipe welding", "Clean bead finish"],
    shiftWeights: [6, 3, 1],
  },
  {
    skillId: "mskill_fitter",
    weight: 7,
    titles: ["Maintenance Fitter", "Mechanical Fitter", "Assembly Fitter"],
    pay: [15000, 25000],
    minExp: [0, 4],
    unit: "auto components plant",
    requirements: ["ITI Fitter", "Preventive maintenance", "Bearing and gearbox fitting", "Hydraulics basics"],
    shiftWeights: [5, 4, 1],
  },
  {
    skillId: "mskill_plumber",
    weight: 4,
    titles: ["Plumber", "Industrial Plumber", "Plumbing Technician"],
    pay: [14000, 22000],
    minExp: [0, 3],
    unit: "construction site",
    requirements: ["GI and CPVC pipe fitting", "Leak testing", "Drawing reading", "Own basic tools"],
    shiftWeights: [9, 1, 0],
  },
  {
    skillId: "mskill_quality_inspector",
    weight: 5,
    titles: ["Quality Inspector", "QC Inspector", "Line Quality Inspector"],
    pay: [16000, 26000],
    minExp: [1, 4],
    unit: "auto components plant",
    requirements: ["Vernier, micrometer and height gauge", "Inspection reports", "PPAP and first piece basics", "Can read drawings"],
    shiftWeights: [5, 4, 1],
  },
  {
    skillId: "mskill_carpenter",
    weight: 4,
    titles: ["Carpenter", "Furniture Carpenter", "Shuttering Carpenter"],
    pay: [15000, 24000],
    minExp: [0, 4],
    unit: "furniture workshop",
    requirements: ["Modular furniture fitting", "Power tools use", "Laminate and edge banding", "Measurement and marking"],
    shiftWeights: [9, 1, 0],
  },
  {
    skillId: "mskill_delivery_rider",
    weight: 6,
    titles: ["Delivery Rider", "Delivery Partner", "Grocery Delivery Rider"],
    pay: [15000, 22000],
    minExp: [0, 1],
    unit: "quick commerce dark store",
    requirements: ["Two wheeler and valid licence", "Smartphone", "Knows local routes"],
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
// Personas — designed, not sampled
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

/**
 * Showcases FIRST, so a small profile (`--personas=5`) always contains both. Every persona
 * holds at least one skill with `skill_related` neighbours it does not itself want, which is
 * what guarantees a non-empty related-only set (carpenter and delivery rider have no
 * neighbours, so they only ever appear as SECOND skills).
 */
export const DEMO_PERSONAS: readonly DemoPersonaSpec[] = [
  {
    key: "showcase-welder-pune",
    name: "Ravi Demo",
    city: "Pune",
    showcase: true,
    story: "Arc welder, 4 years. Sees arc welding jobs first, MIG/TIG jobs as related, no machining or delivery jobs.",
    skills: [{ skillId: "mskill_arc_welder", months: 48 }],
  },
  {
    key: "showcase-fitter-manesar",
    name: "Suresh Demo",
    city: "Manesar",
    showcase: true,
    story: "Maintenance fitter, 5 years (stands in for an electrician — not in the match vocabulary). Plumbing and QC jobs arrive as related.",
    skills: [{ skillId: "mskill_fitter", months: 60 }],
  },
  {
    key: "cnc-turner-pune",
    name: "Amit Demo",
    city: "Pune",
    showcase: false,
    story: "CNC turner, 3 years. VMC, setter, grinding and general CNC jobs arrive as related.",
    skills: [{ skillId: "mskill_cnc_turner", months: 36 }],
  },
  {
    key: "tig-welder-bengaluru",
    name: "Manjunath Demo",
    city: "Bengaluru",
    showcase: false,
    story: "TIG welder who also does arc. MIG-only jobs are related.",
    skills: [
      { skillId: "mskill_tig_welder", months: 72 },
      { skillId: "mskill_arc_welder", months: 12 },
    ],
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
    key: "mig-welder-chennai",
    name: "Senthil Demo",
    city: "Chennai",
    showcase: false,
    story: "MIG welder, 2.5 years. Arc and TIG jobs are related.",
    skills: [{ skillId: "mskill_mig_welder", months: 30 }],
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
    key: "cnc-programmer-bengaluru",
    name: "Prasad Demo",
    city: "Bengaluru",
    showcase: false,
    story: "CNC programmer, 4 years. CAM and setter jobs are related.",
    skills: [{ skillId: "mskill_cnc_programmer", months: 48 }],
  },
  {
    key: "cam-programmer-pune",
    name: "Nikhil Demo",
    city: "Pune",
    showcase: false,
    story: "CAM programmer. CNC programmer and design jobs are related.",
    skills: [{ skillId: "mskill_cam_programmer", months: 30 }],
  },
  {
    key: "designer-ahmedabad",
    name: "Hetal Demo",
    city: "Ahmedabad",
    showcase: false,
    story: "Mechanical CAD designer. CAM and interior design jobs are related.",
    skills: [{ skillId: "mskill_designer", months: 18 }],
  },
  {
    key: "interior-carpenter-bengaluru",
    name: "Ramesh Demo",
    city: "Bengaluru",
    showcase: false,
    story: "Interior draughtsman who is also a carpenter. Mechanical design jobs are related.",
    skills: [
      { skillId: "mskill_interior_designer", months: 24 },
      { skillId: "mskill_carpenter", months: 36 },
    ],
  },
  {
    key: "grinding-manesar",
    name: "Deepak Demo",
    city: "Manesar",
    showcase: false,
    story: "CNC grinding operator. Turner and general CNC jobs are related.",
    skills: [{ skillId: "mskill_cnc_grinding_operator", months: 30 }],
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
    key: "hmc-fresher-manesar",
    name: "Vikas Demo",
    city: "Manesar",
    showcase: false,
    story: "HMC operator, 6 months. Setter, VMC and general CNC jobs are related.",
    skills: [{ skillId: "mskill_hmc_operator", months: 6 }],
  },
  {
    key: "cnc-operator-ahmedabad",
    name: "Bhavesh Demo",
    city: "Ahmedabad",
    showcase: false,
    story: "CNC operator, 1 year. Grinding, turner and HMC jobs are related.",
    skills: [{ skillId: "mskill_cnc_operator_general", months: 12 }],
  },
  {
    key: "carpenter-plumber-pune",
    name: "Santosh Demo",
    city: "Pune",
    showcase: false,
    story: "Carpenter who also does plumbing. Fitter jobs are related (via plumbing).",
    skills: [
      { skillId: "mskill_carpenter", months: 60 },
      { skillId: "mskill_plumber", months: 6 },
    ],
  },
  {
    key: "welder-fitter-manesar",
    name: "Rajesh Demo",
    city: "Manesar",
    showcase: false,
    story: "Arc welder and fitter. MIG/TIG, plumbing and QC jobs are related.",
    skills: [
      { skillId: "mskill_arc_welder", months: 24 },
      { skillId: "mskill_fitter", months: 12 },
    ],
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
  if (!coverage && neighbours.length > 0 && rng.next() < TWO_SKILL_RATE) {
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
  const neededBy = pickWeighted<DemoNeededBy>(["immediate", "soon", "flexible"], [0.4, 0.4, 0.2], rng);
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
  if (count < 1 || count > DEMO_PERSONAS.length) {
    throw new Error(`personas must be in 1..${DEMO_PERSONAS.length} (got ${count})`);
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
  postings: 1080,
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
  const postings = Array.from({ length: options.postings }, (_, i) => buildDemoPosting(i, payers, rng));
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
  postings: ReadonlyArray<{ postingId: string; matchSkillIds: readonly string[]; reachSkillIds: readonly string[] }>,
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

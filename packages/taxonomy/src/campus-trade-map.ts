import {
  MATCH_SKILLS,
  isMatchSkillId,
  matchSkillIndustry,
  type MatchSkillId,
} from "./match-skills";
import { TRADE_CATALOGUE, type TradeCatalogueEntry } from "./trade-catalogue";
import type { IndustryId } from "./index";

/**
 * #3014 — CAMPUS TO BADABHAI: the ONE table that turns a Campus role, a Campus domain and an RVM
 * course into a BadaBhai trade. Every caller reads it: the student import (#2887), the search-grant
 * skill (#2752 item 10, through `instituteCourseMatchSkills`), the admin held list and the coverage
 * report.
 *
 * SOURCE. CEO pack v2 section 7 (`docs/reference/BadaBhai_Manufacturing_Taxonomy_and_Question_
 * Pack_v2.md`), ruled 23 Nov 2026: 7.1 domains, 7.2 roles, 7.3 courses. No row is added that the
 * pack does not name. Owner ruling 25 Nov 2026: the 17 Nov student-import role rows the pack does
 * not name (Press Operator, CAD Draftsman, BIW Designer, CAM Engineer, …) are dropped and go on the
 * held list like any other unnamed role.
 *
 * MATCHING. On the WHOLE normalised name ({@link normalizeCampusName}), never on a word in it:
 * "CNC Operator" is the general CNC skill, "CNC Programmer" is T04, and "Senior CNC Operator" is
 * held until it is ruled. A role the table does not name is "held" — nothing is guessed (pack 7.2:
 * "put it on the held list and send the name; it is ruled in a day").
 *
 * THE RELEASE SWITCH (#3002). A row whose trade is new in CEO pack v2 and companies cannot post
 * yet (`posting_enabled` off) answers "held" with reason `trade_switched_off`, so a Campus job or
 * student is never attached to a new trade before the owner releases it. A skill that was live
 * before v2 passes ({@link CAMPUS_PRE_V2_SKILLS}, decided 25 Nov 2026 under tracking #3024 rule 1).
 * The caller passes the set of posting-enabled kinds (the API reads it from
 * `TradeReleaseService.postingEnabledKinds`); this file reads no database.
 *
 * WHAT IS NOT HERE. What happens to a job on the general CNC skill (an admin narrows it) and to a
 * "label only" role is #3033. Hints are DECLARED (owner ruling 25 Nov 2026) and reported; nothing
 * writes them to a worker yet, and a hint is never a confirmed rung.
 */

// ── Names ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Lower-case, `&` as `and`, punctuation to spaces, one space. The key form for every Campus name
 * (the student import's `normalizeCampusValue` is this function).
 */
export function normalizeCampusName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ── Results ─────────────────────────────────────────────────────────────────────────────────────

/** An answer the import may also set when Campus states it. Never confirmed, never a rung. */
export type CampusHint =
  | {
      readonly kind: "answer";
      /** The worker question key on the trade's pack. */
      readonly questionKey: string;
      /** Stored chip values (pack chip codes). */
      readonly values: readonly string[];
      readonly confirmed: false;
    }
  | {
      /** The software chips, read from the Campus software list (pack 7.2, CAD Designer). */
      readonly kind: "software_chips";
      readonly questionKey: string;
      readonly confirmed: false;
    };

/** Why a name is on the held list. */
export type CampusHeldReason = "not_in_table" | "trade_switched_off";

export type CampusTranslation =
  | {
      readonly kind: "trade";
      /** Pack section 3 code. */
      readonly code: string;
      readonly roleKind: string;
      readonly skillId: MatchSkillId;
      readonly industryId: IndustryId;
      readonly department: string;
      readonly hint: CampusHint | null;
    }
  | {
      /** "Machine Operator", "CNC Operator": the live general CNC skill; #3033 narrows it. */
      readonly kind: "general_cnc";
      readonly skillId: MatchSkillId;
      readonly industryId: IndustryId;
    }
  | { readonly kind: "label_only" }
  | { readonly kind: "no_role" }
  | {
      readonly kind: "held";
      readonly reason: CampusHeldReason;
      /** The trade the table names, when the reason is the switch. */
      readonly code: string | null;
    };

// ── 7.2 Campus role → trade ─────────────────────────────────────────────────────────────────────

type RoleTarget =
  | {
      readonly kind: "trade";
      readonly code: string;
      /** A live skill the pack keeps in place of the trade's own (CNC Programmer). */
      readonly skillId?: MatchSkillId;
      /** CAD Designer: this trade instead when the only software listed is AutoCAD. */
      readonly autocadOnlyCode?: string;
      readonly hint?: CampusHint;
    }
  | { readonly kind: "general_cnc" }
  | { readonly kind: "label_only" };

interface RoleRow {
  /** The role names exactly as pack 7.2 spells them. */
  readonly roles: readonly string[];
  readonly target: RoleTarget;
}

const answer = (questionKey: string, ...values: string[]): CampusHint => ({
  kind: "answer",
  questionKey,
  values,
  confirmed: false,
});
const T58_SPEC = "design_specialisation";

/** Pack 7.2, row for row and in its order. */
export const CAMPUS_ROLE_ROWS: readonly RoleRow[] = [
  {
    roles: ["CAD Designer"],
    target: {
      kind: "trade",
      code: "T58",
      autocadOnlyCode: "T05",
      hint: { kind: "software_chips", questionKey: "design_software", confirmed: false },
    },
  },
  { roles: ["Mechanical Design Engineer", "Design Engineer"], target: { kind: "trade", code: "T58" } },
  {
    roles: ["Product Design Engineer"],
    target: { kind: "trade", code: "T58", hint: answer(T58_SPEC, "product_design") },
  },
  // "Specialisation: mould or press tool" — each role gets the side its name says; a tool
  // designer may be either, and the question is pick-any, so both are offered unconfirmed.
  {
    roles: ["Mold Design Engineer"],
    target: { kind: "trade", code: "T58", hint: answer(T58_SPEC, "mould_design") },
  },
  {
    roles: ["Die Design Engineer"],
    target: { kind: "trade", code: "T58", hint: answer(T58_SPEC, "press_tool") },
  },
  {
    roles: ["Tool Design Engineer"],
    target: { kind: "trade", code: "T58", hint: answer(T58_SPEC, "mould_design", "press_tool") },
  },
  {
    roles: ["Jig & Fixture Design Engineer"],
    target: { kind: "trade", code: "T58", hint: answer(T58_SPEC, "jig_fixture") },
  },
  {
    roles: ["Sheet Metal Design Engineer"],
    target: { kind: "trade", code: "T58", hint: answer(T58_SPEC, "sheet_metal") },
  },
  { roles: ["CAD Drafter", "Draughtsman (Mechanical)"], target: { kind: "trade", code: "T05" } },
  { roles: ["Piping Designer"], target: { kind: "trade", code: "T60" } },
  { roles: ["CAE / FEA Analyst"], target: { kind: "trade", code: "T59" } },
  { roles: ["HVAC Design Engineer"], target: { kind: "label_only" } },
  {
    roles: ["ArtCAM Designer"],
    target: { kind: "trade", code: "T21", hint: answer("router_level", "programmer") },
  },
  { roles: ["CAM Programmer"], target: { kind: "trade", code: "T04" } },
  // "T04 (keep the live CNC Programmer skill as it is)": the trade is T04, the skill stays.
  {
    roles: ["CNC Programmer"],
    target: { kind: "trade", code: "T04", skillId: "mskill_cnc_programmer" },
  },
  { roles: ["Machine Operator", "CNC Operator"], target: { kind: "general_cnc" } },
  { roles: ["CNC Turner", "Lathe Operator"], target: { kind: "trade", code: "T01" } },
  {
    roles: ["VMC Operator", "HMC Operator", "Milling Operator"],
    target: { kind: "trade", code: "T02" },
  },
  { roles: ["Grinding Operator"], target: { kind: "trade", code: "T03" } },
  { roles: ["Wire-cut / EDM Operator"], target: { kind: "trade", code: "T17" } },
  {
    roles: ["Tool & Die Maker", "Tool Room Engineer", "Mould Maker"],
    target: { kind: "trade", code: "T07" },
  },
  { roles: ["Welder"], target: { kind: "trade", code: "T08" } },
  { roles: ["Fabricator"], target: { kind: "trade", code: "T22" } },
  { roles: ["Fitter"], target: { kind: "trade", code: "T12" } },
  // The pack tells the two Manufacturing Engineers apart by what the job does; a bare
  // "Manufacturing Engineer" is not either name, so it is held.
  {
    roles: ["Production Engineer", "Manufacturing Engineer (running a shop)"],
    target: { kind: "trade", code: "T46" },
  },
  {
    roles: [
      "Process Engineer",
      "Industrial Engineer",
      "Tooling Engineer",
      "Manufacturing Engineer (process planning)",
    ],
    target: { kind: "trade", code: "T47" },
  },
  { roles: ["Production Supervisor", "Shift In-charge"], target: { kind: "trade", code: "T45" } },
  {
    roles: ["Quality Engineer", "QA / QC Engineer", "Supplier Quality Engineer"],
    target: { kind: "trade", code: "T37" },
  },
  { roles: ["Quality Inspector", "QC Inspector"], target: { kind: "trade", code: "T16" } },
  { roles: ["CMM Operator / Programmer"], target: { kind: "trade", code: "T33" } },
  { roles: ["NDT Technician"], target: { kind: "trade", code: "T34" } },
  {
    roles: ["PPC Engineer", "Material Planner", "Production Planner"],
    target: { kind: "trade", code: "T52" },
  },
  {
    roles: ["Vendor Development Engineer", "Purchase Engineer", "Sourcing Engineer"],
    target: { kind: "trade", code: "T54" },
  },
  { roles: ["Store Keeper", "Stores Executive"], target: { kind: "trade", code: "T53" } },
  { roles: ["Logistics Executive", "Dispatch Executive"], target: { kind: "trade", code: "T55" } },
  { roles: ["Maintenance Engineer", "Reliability Engineer"], target: { kind: "trade", code: "T43" } },
  { roles: ["Maintenance Technician"], target: { kind: "trade", code: "T13" } },
  {
    roles: ["R&D Engineer", "NPD Engineer", "Prototype Engineer", "Development Engineer"],
    target: { kind: "trade", code: "T48" },
  },
  { roles: ["Field Service Engineer", "Service Engineer"], target: { kind: "trade", code: "T44" } },
  {
    roles: ["Application Engineer", "Technical Sales Engineer", "Pre-sales Engineer"],
    target: { kind: "trade", code: "T51" },
  },
  { roles: ["Project Engineer", "Site Engineer"], target: { kind: "trade", code: "T50" } },
  {
    roles: ["PLC Engineer", "Automation Engineer", "SCADA Engineer", "DCS Engineer"],
    target: { kind: "trade", code: "T38" },
  },
  { roles: ["Robotics Engineer"], target: { kind: "trade", code: "T39" } },
  { roles: ["Instrumentation Engineer"], target: { kind: "trade", code: "T40" } },
  { roles: ["Safety Engineer", "EHS Engineer"], target: { kind: "trade", code: "T49" } },
  {
    roles: [
      "Structural Design Engineer",
      "Bridge Design Engineer",
      "BIM Modeller",
      "CAD Drafter (Civil)",
      "Architectural Designer",
      "Interior Designer",
      "3D Architectural Visualizer",
    ],
    target: { kind: "label_only" },
  },
];

/** Normalised role name → its row's target. */
export const CAMPUS_ROLE_TO_TRADE: ReadonlyMap<string, RoleTarget> = (() => {
  const out = new Map<string, RoleTarget>();
  for (const row of CAMPUS_ROLE_ROWS) {
    for (const role of row.roles) {
      const key = normalizeCampusName(role);
      if (out.has(key)) throw new Error(`campus-trade-map: role "${role}" is listed twice`);
      out.set(key, row.target);
    }
  }
  return out;
})();

// ── Trades ──────────────────────────────────────────────────────────────────────────────────────

const BY_CODE: ReadonlyMap<string, TradeCatalogueEntry> = new Map(
  TRADE_CATALOGUE.map((e) => [e.code, e]),
);

/** The first skill #3001 appended: every skill before it in MATCH_SKILLS predates CEO pack v2. */
const FIRST_V2_SKILL = "mskill_gear_cutting_operator";

/**
 * THE SWITCH HOLDS NEW TRADES ONLY. Skills that were live before CEO pack v2 (#3001 appended the
 * 38 new ones after them, never inserting) pass whatever the switch says: tracking #3024 rule 1,
 * "nothing live changes until a named owner step". T58's `mskill_cad_designer_3d` is the case in
 * point: a live skill a SolidWorks student's grant carries today, on a trade (`cad_designer_3d`)
 * the 0198 seed did not switch on. Holding it would take that card away on deploy. Every trade
 * whose skill is new in v2 is held until the owner switches it on.
 */
export const CAMPUS_PRE_V2_SKILLS: ReadonlySet<string> = (() => {
  const ids = MATCH_SKILLS.map((s) => s.skillId as string);
  const cut = ids.indexOf(FIRST_V2_SKILL);
  if (cut < 0) throw new Error(`campus-trade-map: ${FIRST_V2_SKILL} is not a match skill`);
  return new Set(ids.slice(0, cut));
})();

/** The catalogue trade whose own skill this is, if any. */
const BY_SKILL: ReadonlyMap<string, TradeCatalogueEntry> = new Map(
  TRADE_CATALOGUE.map((e) => [e.matchSkillId, e]),
);

/**
 * May a Campus value be given this skill now: a skill that predates v2, or a trade skill whose
 * trade companies may post. A skill that is no catalogue trade's own (the general CNC skill, a
 * legacy label) predates v2 or is not given.
 */
export function campusSkillReleased(skillId: string, postingEnabled: ReadonlySet<string>): boolean {
  if (CAMPUS_PRE_V2_SKILLS.has(skillId)) return true;
  const entry = BY_SKILL.get(skillId);
  return entry !== undefined && postingEnabled.has(entry.roleKind);
}

/** The catalogue entry for a pack code (every code this file names is pinned by the test). */
export function campusTradeEntry(code: string): TradeCatalogueEntry | undefined {
  return BY_CODE.get(code);
}

function tradeResult(
  code: string,
  postingEnabled: ReadonlySet<string>,
  skillOverride: MatchSkillId | undefined,
  hint: CampusHint | null,
): CampusTranslation {
  const entry = BY_CODE.get(code);
  const skillId = skillOverride ?? entry?.matchSkillId;
  const industryId = skillId === undefined ? undefined : matchSkillIndustry(skillId);
  // Every code names a catalogue trade with a seeded skill (pinned by the test); if one ever
  // goes missing, the name is held rather than attached to a skill with no industry.
  if (!entry || skillId === undefined || !isMatchSkillId(skillId) || industryId === undefined) {
    return { kind: "held", reason: "not_in_table", code };
  }
  if (!campusSkillReleased(skillId, postingEnabled)) {
    return { kind: "held", reason: "trade_switched_off", code };
  }
  return {
    kind: "trade",
    code,
    roleKind: entry.roleKind,
    skillId,
    industryId,
    department: entry.department,
    hint,
  };
}

const GENERAL_CNC: MatchSkillId = "mskill_cnc_operator_general";

/** A name is AutoCAD when its normalised form starts with the word "autocad". */
function isAutocad(name: string): boolean {
  const n = normalizeCampusName(name);
  return n === "autocad" || n.startsWith("autocad ");
}

export interface CampusRoleContext {
  /** Kinds companies may post now (`TradeReleaseService.postingEnabledKinds`). */
  readonly postingEnabled: ReadonlySet<string>;
  /** The Campus software list beside the role (CAD Designer's AutoCAD-only rule). */
  readonly software?: readonly (string | null | undefined)[] | null;
}

/**
 * The trade for one Campus role name (pack 7.2). An empty name is `no_role` (pack: "use the
 * course if he is an RVM student"); a name the table does not hold is `held`.
 */
export function campusRoleTrade(
  role: string | null | undefined,
  ctx: CampusRoleContext,
): CampusTranslation {
  const key = typeof role === "string" ? normalizeCampusName(role) : "";
  if (key.length === 0) return { kind: "no_role" };
  const target = CAMPUS_ROLE_TO_TRADE.get(key);
  if (!target) return { kind: "held", reason: "not_in_table", code: null };
  switch (target.kind) {
    case "label_only":
      return { kind: "label_only" };
    case "general_cnc": {
      // A live skill, not a trade kind: no release switch applies to it.
      const industryId = matchSkillIndustry(GENERAL_CNC);
      return industryId === undefined
        ? { kind: "held", reason: "not_in_table", code: null }
        : { kind: "general_cnc", skillId: GENERAL_CNC, industryId };
    }
    case "trade": {
      const software = (ctx.software ?? []).filter(
        (s): s is string => typeof s === "string" && normalizeCampusName(s).length > 0,
      );
      const autocadOnly = software.length > 0 && software.every(isAutocad);
      if (target.autocadOnlyCode && autocadOnly) {
        return tradeResult(target.autocadOnlyCode, ctx.postingEnabled, undefined, null);
      }
      return tradeResult(target.code, ctx.postingEnabled, target.skillId, target.hint ?? null);
    }
  }
}

// ── 7.3 RVM course → trade ──────────────────────────────────────────────────────────────────────

type CourseTarget = { readonly kind: "trade"; readonly code: string } | { readonly kind: "label_only" };

interface CourseRow {
  /** Course names exactly as pack 7.3 spells them. */
  readonly courses: readonly string[];
  /**
   * The pack's family words: "the other AutoCAD courses", "PLC courses", "Revit, Staad and other
   * civil tools". A course whose normalised name STARTS with one of these words is in the row.
   * Only these four families exist; nothing else matches on a word.
   */
  readonly families?: readonly string[];
  readonly target: CourseTarget;
}

/** Pack 7.3, row for row. Every course gives level `trainee`, not confirmed. */
export const RVM_COURSE_ROWS: readonly CourseRow[] = [
  {
    courses: ["CNC", "CNC Operating + Setting", "CNC C-Axis", "CNC Y-Axis"],
    target: { kind: "trade", code: "T01" },
  },
  { courses: ["VMC", "VMC Operating + Setting"], target: { kind: "trade", code: "T02" } },
  { courses: ["AutoCAD Mechanical"], families: ["autocad"], target: { kind: "trade", code: "T05" } },
  { courses: ["SolidWorks", "CATIA", "NX CAD", "Creo"], target: { kind: "trade", code: "T58" } },
  {
    // Whole names only, like the roles: "Delcam / PowerMill" is that name, and a course called
    // just "PowerMill" is held until it is ruled.
    courses: [
      "Mastercam",
      "Delcam / PowerMill",
      "SolidCAM",
      "NX CAM",
      "Work NC",
      "Fusion 360 CAM",
      "Esprit",
    ],
    target: { kind: "trade", code: "T04" },
  },
  { courses: ["ArtCAM"], target: { kind: "trade", code: "T21" } },
  {
    courses: ["HMI", "SCADA", "Full Automation"],
    families: ["plc"],
    target: { kind: "trade", code: "T38" },
  },
  { courses: ["Robotics"], target: { kind: "trade", code: "T39" } },
  { courses: [], families: ["revit", "staad"], target: { kind: "label_only" } },
];

const COURSE_EXACT: ReadonlyMap<string, CourseTarget> = (() => {
  const out = new Map<string, CourseTarget>();
  for (const row of RVM_COURSE_ROWS) {
    for (const c of row.courses) {
      const key = normalizeCampusName(c);
      if (out.has(key)) throw new Error(`campus-trade-map: course "${c}" is listed twice`);
      out.set(key, row.target);
    }
  }
  return out;
})();
const COURSE_FAMILIES: readonly { word: string; target: CourseTarget }[] = RVM_COURSE_ROWS.flatMap(
  (row) => (row.families ?? []).map((word) => ({ word, target: row.target })),
);

/**
 * The separate course names in one RVM course string (`courses_str` lists them with commas). A
 * `+` or `/` stays inside a name ("CNC Operating + Setting", "Delcam / PowerMill").
 */
export function splitRvmCourses(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,;|\n]+/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => normalizeCampusName(s).length > 0);
}

function courseTarget(course: string): CourseTarget | undefined {
  const key = normalizeCampusName(course);
  const exact = COURSE_EXACT.get(key);
  if (exact) return exact;
  const first = key.split(" ")[0] ?? "";
  return COURSE_FAMILIES.find((f) => f.word === first)?.target;
}

/** One trade a course gives: always level `trainee`, never confirmed (pack 7.3). */
export interface RvmCourseTrade {
  readonly course: string;
  readonly code: string;
  readonly roleKind: string;
  readonly skillId: MatchSkillId;
  readonly industryId: IndustryId;
  readonly level: "trainee";
  readonly confirmed: false;
}

export interface RvmCourseTranslation {
  /** One per trade, in the order the courses are listed (a trade two courses give appears once). */
  readonly trades: readonly RvmCourseTrade[];
  readonly labelOnly: readonly string[];
  /** Courses with no row, or whose trade is switched off. */
  readonly held: readonly { readonly course: string; readonly reason: CampusHeldReason }[];
}

/**
 * The trades for the RVM courses in `courses` (one string or several; each is split on commas).
 * A student with two courses gets both trades; "CNC" never means CNC Programmer.
 */
export function rvmCourseTrades(
  courses: string | readonly (string | null | undefined)[] | null | undefined,
  postingEnabled: ReadonlySet<string>,
): RvmCourseTranslation {
  const names = (typeof courses === "string" || courses == null ? [courses] : courses).flatMap(
    (c) => splitRvmCourses(c),
  );
  const trades: RvmCourseTrade[] = [];
  const labelOnly: string[] = [];
  const held: { course: string; reason: CampusHeldReason }[] = [];
  const seenCourse = new Set<string>();
  for (const course of names) {
    const key = normalizeCampusName(course);
    if (seenCourse.has(key)) continue;
    seenCourse.add(key);
    const target = courseTarget(course);
    if (!target) {
      held.push({ course, reason: "not_in_table" });
      continue;
    }
    if (target.kind === "label_only") {
      labelOnly.push(course);
      continue;
    }
    const r = tradeResult(target.code, postingEnabled, undefined, null);
    if (r.kind === "held") {
      held.push({ course, reason: r.reason });
      continue;
    }
    if (r.kind !== "trade") continue;
    if (trades.some((t) => t.skillId === r.skillId)) continue;
    trades.push({
      course,
      code: r.code,
      roleKind: r.roleKind,
      skillId: r.skillId,
      industryId: r.industryId,
      level: "trainee",
      confirmed: false,
    });
  }
  return { trades, labelOnly, held };
}

// ── 7.1 Campus domain → department ──────────────────────────────────────────────────────────────

type DomainTarget =
  | { readonly kind: "department"; readonly department: string }
  /** The department of the role's trade, when it is one of these. */
  | { readonly kind: "by_role"; readonly departments: readonly string[] }
  | { readonly kind: "none" };

const P_AND_E = "Production & Engineering";
const M_AND_A = "Maintenance & Automation";

/**
 * Pack 7.1. FOR GROUPING AND REPORTS ONLY: a domain never decides a trade or a match.
 */
export const CAMPUS_DOMAIN_ROWS: readonly { domains: readonly string[]; target: DomainTarget }[] = [
  { domains: ["Design Mechanical"], target: { kind: "department", department: "Design" } },
  {
    domains: ["Production"],
    target: {
      kind: "by_role",
      departments: [
        "Machining",
        "Tool Room",
        "Sheet Metal & Fabrication",
        "Casting, Forging & Surface Treatment",
        "Plastics & Rubber",
        "Assembly",
        P_AND_E,
      ],
    },
  },
  { domains: ["Quality"], target: { kind: "department", department: "Quality & Metrology" } },
  {
    domains: ["Supply Chain"],
    target: { kind: "department", department: "Planning & Supply Chain" },
  },
  { domains: ["Maintenance & Reliability"], target: { kind: "department", department: M_AND_A } },
  { domains: ["R&D / NPD"], target: { kind: "department", department: P_AND_E } },
  { domains: ["Service & Aftermarket"], target: { kind: "by_role", departments: [M_AND_A, P_AND_E] } },
  { domains: ["Project & Site"], target: { kind: "department", department: P_AND_E } },
  {
    domains: ["Automation & Mechatronics", "Industrial Automation (Electrical)"],
    target: { kind: "department", department: M_AND_A },
  },
  { domains: ["HSE / Safety"], target: { kind: "department", department: P_AND_E } },
  { domains: ["Technical Sales & Marketing"], target: { kind: "department", department: P_AND_E } },
  { domains: ["Design Civil", "Design Architecture"], target: { kind: "none" } },
];

export const CAMPUS_DOMAIN_TO_DEPARTMENT: ReadonlyMap<string, DomainTarget> = new Map(
  CAMPUS_DOMAIN_ROWS.flatMap((row) => row.domains.map((d) => [normalizeCampusName(d), row.target])),
);

/**
 * The BadaBhai department for a Campus domain (pack 7.1), using the role's translation where the
 * pack says "by role". Null for a domain with no department, an unknown domain, or a "by role"
 * domain whose role has no trade in one of its departments.
 */
export function campusDomainDepartment(
  domain: string | null | undefined,
  role: CampusTranslation | null,
): string | null {
  if (typeof domain !== "string") return null;
  const target = CAMPUS_DOMAIN_TO_DEPARTMENT.get(normalizeCampusName(domain));
  if (!target) return null;
  switch (target.kind) {
    case "department":
      return target.department;
    case "none":
      return null;
    case "by_role":
      return role?.kind === "trade" && target.departments.includes(role.department)
        ? role.department
        : null;
  }
}

/** For the tests: every pack code the role and course rows name. */
export const CAMPUS_TRADE_MAP_CODES: readonly string[] = [
  ...new Set([
    ...CAMPUS_ROLE_ROWS.flatMap((r) =>
      r.target.kind === "trade"
        ? [r.target.code, ...(r.target.autocadOnlyCode ? [r.target.autocadOnlyCode] : [])]
        : [],
    ),
    ...RVM_COURSE_ROWS.flatMap((r) => (r.target.kind === "trade" ? [r.target.code] : [])),
  ]),
];

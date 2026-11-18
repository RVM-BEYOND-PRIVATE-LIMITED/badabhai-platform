import { bucketMonthValue } from "@badabhai/match-engine";
import {
  instituteCourseMatchSkill,
  isMatchSkillId,
  matchSkillIndustry,
  type IndustryId,
  type MatchSkillId,
} from "@badabhai/taxonomy";

/**
 * #2887 — mapping a moved RVM student's Campus job profile to BadaBhai's match skills.
 *
 * THE RULE (owner ruling, 17 Nov 2026): map only values whose BadaBhai skill is CERTAIN. Every
 * other value — a closest fit (Mold Maker, Machine Setter, a tool or piping designer), a value
 * with no BadaBhai skill at all (civil, BIM, structural, architecture, CAE/FEA), or free text —
 * goes to the UNMAPPED REPORT with where it came from, for an owner ruling before the bulk run.
 * Nothing is guessed: a student whose values are all unmapped gets no skill row and reaches no job.
 *
 * WHERE A SKILL COMES FROM (in this order, all of them feeding one set):
 *   1. the profile's `job_role`, and each experience row's and RVM certification's `job_role`;
 *   2. the profile's `cad_software` and `skills`, each experience row's and RVM certification's
 *      `skills`, and each `skill_experience` row's `skill`;
 *   3. the RVM course and trade, through #2752's existing word rule (`instituteCourseMatchSkill`),
 *      so a moved student and a linked student with the same course get the same skill.
 * `job_domain` and `industry` never decide a skill on their own: every domain spans several skills,
 * so a domain is reported when nothing else on the profile maps.
 *
 * MONTHS per skill: the most months any evidence for that skill states (a `skill_experience` row,
 * an experience row's `duration_months` for its role or skills, an RVM certification's
 * `training_months`), bucketed down to 6-month steps like every derived skill row
 * (`bucketMonthValue`; under 6 months reads as 0, "not recorded"). Never the profile's total.
 *
 * PURE: no database, no clock, no I/O. The import CLI feeds it one bundle line and writes what it
 * returns, subject to the field source marker (a field the worker edited on BadaBhai is kept).
 */

/** The parts of one bundle v1 student line (`docs/api/student-export-bundle.md`) this reads. */
export interface CampusStudentProfileInput {
  readonly rvm?: {
    readonly course?: string | null;
    readonly trade?: string | null;
  } | null;
  readonly profile?: {
    readonly total_experience_months?: number | null;
    readonly is_fresher?: boolean | null;
    readonly skills?: readonly string[] | null;
    readonly cad_software?: readonly string[] | null;
    readonly industry?: string | null;
    readonly job_domain?: string | null;
    readonly job_role?: string | null;
  } | null;
  readonly experience?:
    | readonly {
        readonly job_role?: string | null;
        readonly job_domain?: string | null;
        readonly skills?: readonly string[] | null;
        readonly duration_months?: number | null;
      }[]
    | null;
  readonly skill_experience?:
    | readonly {
        readonly skill?: string | null;
        readonly months?: number | null;
      }[]
    | null;
  readonly certifications?:
    | readonly {
        readonly name?: string | null;
        readonly issuing_authority?: string | null;
        readonly issue_date?: string | null;
      }[]
    | null;
  readonly rvm_certifications?:
    | readonly {
        readonly job_role?: string | null;
        readonly job_domain?: string | null;
        readonly skills?: readonly string[] | null;
        readonly training_months?: number | null;
      }[]
    | null;
}

/** Where an unmapped value was found. */
export type UnmappedField = "job_role" | "job_domain" | "skill" | "cad_software" | "course";

export interface MappedSkill {
  readonly skillId: MatchSkillId;
  readonly industryId: IndustryId;
  /** The most months any evidence states (0 when none does). */
  readonly months: number;
  /** `months` bucketed down to 6-month steps: the `worker_skill.months_bucketed` value. */
  readonly monthsBucketed: number;
}

export interface MappedCertificate {
  /** 1–120 characters (`worker_certificate.name`). */
  readonly name: string;
  readonly issuer: string | null;
  readonly year: number | null;
  /** An approved RVM CAD certification (shown apart from the others). */
  readonly rvm: boolean;
}

export interface MappedStudentProfile {
  /** Sorted by skill id; one entry per skill. */
  readonly skills: readonly MappedSkill[];
  /** The profile's stated total, in months; null when Campus has none. */
  readonly totalExperienceMonths: number | null;
  readonly certificates: readonly MappedCertificate[];
  /** Each distinct value with no certain BadaBhai skill, with the field it came from. */
  readonly unmapped: readonly { readonly field: UnmappedField; readonly value: string }[];
}

/** The month bucket every derived skill row uses (`packages/match-engine` config `monthBucket`). */
export const CAMPUS_IMPORT_MONTH_BUCKET = 6;

/** Lower-case, `&` as `and`, punctuation to spaces, one space: the dictionaries' key form. */
export function normalizeCampusValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * CERTAIN job roles only (Campus's `JOB_TAXONOMY`, its legacy domains and its course prefill).
 * Every role not listed here is reported.
 */
const ROLE_SKILLS: Readonly<Record<string, MatchSkillId>> = keyed({
  "Product Design Engineer": "mskill_cad_designer_3d",
  "BIW Designer (Automotive)": "mskill_cad_designer_3d",
  "BIW Designer": "mskill_cad_designer_3d",
  "CAD Draftsman": "mskill_designer",
  "CAM Programmer": "mskill_cam_programmer",
  "CAD/CAM Programmer": "mskill_cam_programmer",
  "CAM Engineer": "mskill_cam_programmer",
  "Toolpath Programmer": "mskill_cam_programmer",
  "CNC Programmer": "mskill_cnc_programmer",
  "VMC Programmer": "mskill_cnc_programmer",
  "CNC//VMC Programmer": "mskill_cnc_programmer",
  "CNC/VMC Programmer": "mskill_cnc_programmer",
  Welder: "mskill_welder",
  Fitter: "mskill_fitter",
  "Tool & Die Maker": "mskill_tool_die_maker",
  "Press Operator": "mskill_press_operator",
  "Interior Designer": "mskill_interior_designer",
  "Quality Inspector": "mskill_quality_inspector",
  "CMM Operator / Programmer": "mskill_quality_inspector",
  "CMM Operator": "mskill_quality_inspector",
});

/**
 * CERTAIN software and skill names (Campus's `cad_software` options and the matching `skills`
 * chips). A 2D drafting package is the 2D draughtsman; a 3D CAD package is the 3D CAD designer;
 * a CAM package is the CAM programmer. Visualisation packages (SketchUp, 3ds Max, V-Ray, Lumion),
 * Rhino, Revit, analysis, civil and plant-design packages are reported.
 */
const SOFTWARE_SKILLS: Readonly<Record<string, MatchSkillId>> = keyed({
  AutoCAD: "mskill_designer",
  "AutoCAD Mechanical": "mskill_designer",
  "2D Drafting": "mskill_designer",
  "Engineering Drawings": "mskill_designer",
  SolidWorks: "mskill_cad_designer_3d",
  "SolidWorks Sheet Metal": "mskill_cad_designer_3d",
  CATIA: "mskill_cad_designer_3d",
  Creo: "mskill_cad_designer_3d",
  "PTC Creo": "mskill_cad_designer_3d",
  Inventor: "mskill_cad_designer_3d",
  "Autodesk Inventor": "mskill_cad_designer_3d",
  NX: "mskill_cad_designer_3d",
  "NX (Siemens)": "mskill_cad_designer_3d",
  "Siemens NX": "mskill_cad_designer_3d",
  Unigraphics: "mskill_cad_designer_3d",
  "Fusion 360": "mskill_cad_designer_3d",
  "Solid Edge": "mskill_cad_designer_3d",
  "3D Modelling": "mskill_cad_designer_3d",
  "3D Modeling": "mskill_cad_designer_3d",
  Mastercam: "mskill_cam_programmer",
  PowerMill: "mskill_cam_programmer",
  SolidCAM: "mskill_cam_programmer",
  EdgeCAM: "mskill_cam_programmer",
});

function keyed(table: Record<string, MatchSkillId>): Record<string, MatchSkillId> {
  const out: Record<string, MatchSkillId> = {};
  for (const [label, skill] of Object.entries(table)) out[normalizeCampusValue(label)] = skill;
  return out;
}

/** The certain skill for a job role, or null. */
export function campusRoleSkill(role: string | null | undefined): MatchSkillId | null {
  if (!role) return null;
  return ROLE_SKILLS[normalizeCampusValue(role)] ?? null;
}

/** The certain skill for a software or skill name, or null. */
export function campusSoftwareSkill(name: string | null | undefined): MatchSkillId | null {
  if (!name) return null;
  return SOFTWARE_SKILLS[normalizeCampusValue(name)] ?? null;
}

/** A finite, non-negative whole number of months, or null. */
function monthsOf(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** A four-digit year at the start of a Campus date string ("2023", "2023-05-01"), or null. */
function yearOf(value: string | null | undefined): number | null {
  const m = typeof value === "string" ? /^(\d{4})/.exec(value.trim()) : null;
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1950 && year <= 2100 ? year : null;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

export function mapCampusStudentProfile(input: CampusStudentProfileInput): MappedStudentProfile {
  const months = new Map<MatchSkillId, number>();
  const unmapped = new Map<string, { field: UnmappedField; value: string }>();

  const credit = (skill: MatchSkillId, m: number | null): void => {
    if (!isMatchSkillId(skill)) return;
    months.set(skill, Math.max(months.get(skill) ?? 0, m ?? 0));
  };
  const report = (field: UnmappedField, value: string | null | undefined): void => {
    const v = clean(value);
    if (v === null) return;
    const key = `${field}|${normalizeCampusValue(v)}`;
    if (!unmapped.has(key)) unmapped.set(key, { field, value: v });
  };
  /** A role: its certain skill gets `m` months, or the role is reported. */
  const role = (value: string | null | undefined, m: number | null): MatchSkillId | null => {
    if (!clean(value)) return null;
    const skill = campusRoleSkill(value);
    if (skill) credit(skill, m);
    else report("job_role", value);
    return skill;
  };
  /** A software or skill name: its certain skill gets `m` months, or the name is reported. */
  const named = (
    field: "skill" | "cad_software",
    value: string | null | undefined,
    m: number | null,
  ): MatchSkillId | null => {
    if (!clean(value)) return null;
    const skill = campusSoftwareSkill(value);
    if (skill) credit(skill, m);
    else report(field, value);
    return skill;
  };

  const profile = input.profile ?? {};
  let anySkill = false;

  if (role(profile.job_role, null)) anySkill = true;
  for (const s of profile.cad_software ?? []) if (named("cad_software", s, null)) anySkill = true;
  for (const s of profile.skills ?? []) if (named("skill", s, null)) anySkill = true;
  for (const row of input.skill_experience ?? []) {
    if (named("skill", row.skill, monthsOf(row.months))) anySkill = true;
  }
  for (const row of input.experience ?? []) {
    const m = monthsOf(row.duration_months);
    if (role(row.job_role, m)) anySkill = true;
    for (const s of row.skills ?? []) if (named("skill", s, m)) anySkill = true;
  }
  for (const row of input.rvm_certifications ?? []) {
    const m = monthsOf(row.training_months);
    if (role(row.job_role, m)) anySkill = true;
    for (const s of row.skills ?? []) if (named("skill", s, m)) anySkill = true;
  }

  // The RVM course and trade, through #2752's rule (the same skill a linked student's grant gets).
  const course = [clean(input.rvm?.course), clean(input.rvm?.trade)].filter(
    (v): v is string => v !== null,
  );
  if (course.length > 0) {
    const fromCourse = instituteCourseMatchSkill(course.join(" "));
    if (fromCourse) {
      credit(fromCourse.skillId, null);
      anySkill = true;
    } else {
      report("course", course.join(" / "));
    }
  }

  // A domain is a hint only: reported when nothing on the profile mapped, so a ruling can follow.
  if (!anySkill) {
    report("job_domain", profile.job_domain);
    for (const row of input.experience ?? []) report("job_domain", row.job_domain);
    for (const row of input.rvm_certifications ?? []) report("job_domain", row.job_domain);
  }

  const skills: MappedSkill[] = [...months.entries()]
    .flatMap(([skillId, m]) => {
      const industryId = matchSkillIndustry(skillId);
      return industryId === undefined
        ? []
        : [
            {
              skillId,
              industryId,
              months: m,
              monthsBucketed: bucketMonthValue(m, CAMPUS_IMPORT_MONTH_BUCKET),
            },
          ];
    })
    .sort((a, b) => a.skillId.localeCompare(b.skillId));

  const certificates: MappedCertificate[] = [];
  const seenCert = new Set<string>();
  const addCert = (
    name: string | null | undefined,
    issuer: string | null,
    year: number | null,
    rvm: boolean,
  ): void => {
    const n = clean(name);
    if (n === null) return;
    const trimmed = n.slice(0, 120);
    const key = normalizeCampusValue(trimmed);
    if (seenCert.has(key)) return;
    seenCert.add(key);
    certificates.push({ name: trimmed, issuer, year, rvm });
  };
  for (const row of input.rvm_certifications ?? []) {
    // An approved RVM CAD certification is named by its role (or its first skill) and issued by
    // RVM CAD; its training dates identify the batch and are not in the bundle.
    const label = clean(row.job_role) ?? clean(row.skills?.[0]);
    if (label) addCert(`RVM CAD certification: ${label}`, "RVM CAD", null, true);
  }
  for (const row of input.certifications ?? []) {
    addCert(
      row.name,
      clean(row.issuing_authority)?.slice(0, 120) ?? null,
      yearOf(row.issue_date),
      false,
    );
  }

  return {
    skills,
    totalExperienceMonths:
      profile.is_fresher === true ? 0 : monthsOf(profile.total_experience_months),
    certificates,
    unmapped: [...unmapped.values()].sort(
      (a, b) => a.field.localeCompare(b.field) || a.value.localeCompare(b.value),
    ),
  };
}

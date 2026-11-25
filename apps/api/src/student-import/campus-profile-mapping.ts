import { bucketMonthValue } from "@badabhai/match-engine";
import {
  campusRoleTrade,
  campusSkillReleased,
  isMatchSkillId,
  matchSkillIndustry,
  normalizeCampusName,
  rvmCourseTrades,
  type CampusHeldReason,
  type CampusHint,
  type CampusTranslation,
  type IndustryId,
  type MatchSkillId,
} from "@badabhai/taxonomy";

/**
 * #2887 — mapping a moved RVM student's Campus job profile to BadaBhai's match skills.
 *
 * THE RULE (owner ruling, 17 Nov 2026): map only values whose BadaBhai skill is CERTAIN. Every
 * other value goes to the UNMAPPED REPORT with where it came from, for an owner ruling before the
 * bulk run. Nothing is guessed: a student whose values are all unmapped gets no skill row and
 * reaches no job.
 *
 * ROLES AND COURSES (#3014): through the ONE Campus table (`@badabhai/taxonomy`
 * campus-trade-map, CEO pack v2 section 7). A role or course the table does not name, or whose
 * trade companies cannot post yet (#3002 switch off), is HELD: reported, no skill. A "label only"
 * role or course (civil, architecture, HVAC design, Revit, Staad) is ruled, so it is not reported
 * as unmapped; it is listed in `labelOnly` and gets no skill (#3033 keeps it as a label). Hints the
 * table declares are listed in `hints`, never written (owner ruling 25 Nov 2026).
 *
 * WHERE A SKILL COMES FROM (in this order, all of them feeding one set):
 *   1. the profile's `job_role`, and each experience row's and RVM certification's `job_role`
 *      (pack 7.2; CAD Designer reads the profile's `cad_software` for its AutoCAD-only rule);
 *   2. the profile's `cad_software` and `skills`, each experience row's and RVM certification's
 *      `skills`, and each `skill_experience` row's `skill` (the 17 Nov software table below);
 *   3. the RVM course and trade (pack 7.3, `rvmCourseTrades`), the same rule a linked student's
 *      search grant reads, so a moved student and a linked student with the same course get the
 *      same skills. Two courses give both trades.
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

/** Why a value is unmapped: the Campus table's held reasons, or no certain skill (the rest). */
export type UnmappedReason = CampusHeldReason | "no_certain_skill";

/** What the mapping needs besides the line: the release switch (#3002). */
export interface CampusMappingContext {
  /** Kinds companies may post now (`TradeReleaseService.postingEnabledKinds`). */
  readonly postingEnabled: ReadonlySet<string>;
}

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
  readonly unmapped: readonly {
    readonly field: UnmappedField;
    readonly value: string;
    readonly reason: UnmappedReason;
  }[];
  /** Roles and courses the table rules "label only" (no skill, not held). Sorted. */
  readonly labelOnly: readonly { readonly field: "job_role" | "course"; readonly value: string }[];
  /** Hints the table declares for a mapped role (reported, never written). */
  readonly hints: readonly { readonly role: string; readonly hint: CampusHint }[];
}

/** The month bucket every derived skill row uses (`packages/match-engine` config `monthBucket`). */
export const CAMPUS_IMPORT_MONTH_BUCKET = 6;

/** Lower-case, `&` as `and`, punctuation to spaces, one space: the Campus table's key form. */
export const normalizeCampusValue: (value: string) => string = normalizeCampusName;

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

/**
 * The Campus table's answer for a job role (pack 7.2). `software` is the profile's software list
 * (CAD Designer's AutoCAD-only rule).
 */
export function campusRoleSkill(
  role: string | null | undefined,
  ctx: CampusMappingContext,
  software?: readonly (string | null | undefined)[] | null,
): CampusTranslation {
  return campusRoleTrade(role, { postingEnabled: ctx.postingEnabled, software });
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

export function mapCampusStudentProfile(
  input: CampusStudentProfileInput,
  ctx: CampusMappingContext,
): MappedStudentProfile {
  const months = new Map<MatchSkillId, number>();
  const unmapped = new Map<
    string,
    { field: UnmappedField; value: string; reason: UnmappedReason }
  >();
  const labelOnly = new Map<string, { field: "job_role" | "course"; value: string }>();
  const hints = new Map<string, { role: string; hint: CampusHint }>();
  const software = input.profile?.cad_software ?? null;

  const credit = (skill: MatchSkillId, m: number | null): void => {
    if (!isMatchSkillId(skill)) return;
    months.set(skill, Math.max(months.get(skill) ?? 0, m ?? 0));
  };
  const report = (
    field: UnmappedField,
    value: string | null | undefined,
    reason: UnmappedReason = "no_certain_skill",
  ): void => {
    const v = clean(value);
    if (v === null) return;
    const key = `${field}|${normalizeCampusValue(v)}`;
    if (!unmapped.has(key)) unmapped.set(key, { field, value: v, reason });
  };
  const label = (field: "job_role" | "course", value: string): void => {
    const key = `${field}|${normalizeCampusValue(value)}`;
    if (!labelOnly.has(key)) labelOnly.set(key, { field, value });
  };
  /** A role: its trade's skill gets `m` months; a label-only role is listed; any other is held. */
  const role = (value: string | null | undefined, m: number | null): MatchSkillId | null => {
    const v = clean(value);
    if (!v) return null;
    const t = campusRoleSkill(v, ctx, software);
    switch (t.kind) {
      case "trade":
      case "general_cnc":
        credit(t.skillId, m);
        if (t.kind === "trade" && t.hint) {
          const key = normalizeCampusValue(v);
          if (!hints.has(key)) hints.set(key, { role: v, hint: t.hint });
        }
        return t.skillId;
      case "label_only":
        label("job_role", v);
        return null;
      case "held":
        report("job_role", v, t.reason);
        return null;
      case "no_role":
        return null;
    }
  };
  /** A software or skill name: its certain skill gets `m` months, or the name is reported. */
  const named = (
    field: "skill" | "cad_software",
    value: string | null | undefined,
    m: number | null,
  ): MatchSkillId | null => {
    if (!clean(value)) return null;
    const skill = campusSoftwareSkill(value);
    if (!skill) {
      report(field, value);
      return null;
    }
    // The same release gate as roles and courses (#3014): a software skill on a new trade that is
    // switched off is held. Every skill in the table below predates v2, so none is held today.
    if (!campusSkillReleased(skill, ctx.postingEnabled)) {
      report(field, value, "trade_switched_off");
      return null;
    }
    credit(skill, m);
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

  // The RVM course and trade (pack 7.3): the same rule a linked student's grant reads. Every
  // course gives its trade at trainee; two courses give both.
  const fromCourse = rvmCourseTrades([input.rvm?.course, input.rvm?.trade], ctx.postingEnabled);
  for (const t of fromCourse.trades) {
    credit(t.skillId, null);
    anySkill = true;
  }
  for (const c of fromCourse.labelOnly) label("course", c);
  for (const h of fromCourse.held) report("course", h.course, h.reason);

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
    labelOnly: [...labelOnly.values()].sort(
      (a, b) => a.field.localeCompare(b.field) || a.value.localeCompare(b.value),
    ),
    hints: [...hints.values()].sort((a, b) => a.role.localeCompare(b.role)),
  };
}

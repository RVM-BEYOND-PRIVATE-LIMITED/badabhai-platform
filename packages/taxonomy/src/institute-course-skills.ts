import { matchSkillIndustry, type MatchSkillId } from "./match-skills";
import type { IndustryId } from "./index";

/**
 * #2752 item 10 — the ONE match skill an institute course maps to, for named-company search.
 *
 * A linked student has no `worker_skill` row of his own, and a company's search builds every card
 * from a skill. So a search grant carries the skill his course maps to, with its industry (months
 * unknown, printed as unrecorded). A deterministic rule over the course NAME RVM sends
 * (`v_admission_financial_summary.courses_str`, Scheduler_Backend#162): the name is split into
 * lower-case words, and the FIRST rule below with a word in it wins, so a student with "AutoCAD,
 * SolidWorks" maps to the 3D designer, the more advanced of the two. A course no rule names maps to
 * null: the grant is still stored and lets that company open him, but he has no card in its search
 * until a rule covers his course.
 *
 * Words, never substrings: "cam" must not match "campus", and "nx" only the NX (Unigraphics) word.
 */
const RULES: readonly { readonly words: readonly string[]; readonly skillId: MatchSkillId }[] = [
  { words: ["cnc"], skillId: "mskill_cnc_programmer" },
  { words: ["cam", "mastercam", "powermill", "edgecam"], skillId: "mskill_cam_programmer" },
  {
    words: ["solidworks", "catia", "creo", "nx", "unigraphics", "inventor", "fusion", "3d"],
    skillId: "mskill_cad_designer_3d",
  },
  {
    words: ["interior", "sketchup", "3ds", "3dsmax", "vray", "lumion"],
    skillId: "mskill_interior_designer",
  },
  { words: ["autocad", "cad", "drafting", "draughting", "2d"], skillId: "mskill_designer" },
];

export interface InstituteCourseSkill {
  readonly skillId: MatchSkillId;
  readonly industryId: IndustryId;
}

/** The skill and industry for a course name, or null when no rule names one of its words. */
export function instituteCourseMatchSkill(
  course: string | null | undefined,
): InstituteCourseSkill | null {
  if (!course) return null;
  const words = new Set(
    course
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0),
  );
  for (const rule of RULES) {
    if (!rule.words.some((w) => words.has(w))) continue;
    const industryId = matchSkillIndustry(rule.skillId);
    // Every rule names a seeded match skill (pinned by the test), so this never fires; if a seed
    // ever loses one, the course maps to nothing rather than to a skill with no industry.
    return industryId === undefined ? null : { skillId: rule.skillId, industryId };
  }
  return null;
}

/** For the test: every skill a rule can return. */
export const INSTITUTE_COURSE_RULE_SKILLS: readonly MatchSkillId[] = RULES.map((r) => r.skillId);

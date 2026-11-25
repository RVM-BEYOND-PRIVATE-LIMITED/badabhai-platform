import type { MatchSkillId } from "./match-skills";
import type { IndustryId } from "./index";
import { RVM_COURSE_ROWS, campusTradeEntry, rvmCourseTrades } from "./campus-trade-map";

/**
 * #2752 item 10, ruled by #3014 — the match skills an institute course maps to.
 *
 * A linked student has no `worker_skill` row of his own, and a company's search builds every card
 * from a skill, so a search grant carries a skill from his course. The rule is CEO pack v2 section
 * 7.3, through the one Campus table (`campus-trade-map.ts`): each course NAME in RVM's course
 * string (`v_admission_financial_summary.courses_str`, comma-separated) is matched WHOLE, every
 * course gives its trade at level `trainee` (not confirmed), and a student with two courses gets
 * both. "CNC" is the CNC Turner, never the CNC Programmer.
 *
 * A course with no row, a "label only" course (Revit, Staad), or a course whose trade is new in
 * CEO pack v2 and companies cannot post yet (#3002 switch off) gives nothing; a skill live before
 * v2 always passes (`CAMPUS_PRE_V2_SKILLS`). The grant is still stored and lets that company
 * open him; he has no card in its search until his course gives a released trade.
 */

export interface InstituteCourseSkill {
  readonly skillId: MatchSkillId;
  readonly industryId: IndustryId;
}

/**
 * Every skill the course string gives, in the order its courses are listed (first listed first).
 * `postingEnabled` is the set of kinds companies may post now (`TradeReleaseService`).
 */
export function instituteCourseMatchSkills(
  course: string | null | undefined,
  postingEnabled: ReadonlySet<string>,
): InstituteCourseSkill[] {
  return rvmCourseTrades(course, postingEnabled).trades.map((t) => ({
    skillId: t.skillId,
    industryId: t.industryId,
  }));
}

/** For the test: every skill a course row can give. */
export const INSTITUTE_COURSE_RULE_SKILLS: readonly string[] = RVM_COURSE_ROWS.flatMap((r) =>
  r.target.kind === "trade" ? [campusTradeEntry(r.target.code)?.matchSkillId ?? "(missing)"] : [],
);

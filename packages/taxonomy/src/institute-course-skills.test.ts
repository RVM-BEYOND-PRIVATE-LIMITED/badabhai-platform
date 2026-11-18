import { describe, expect, it } from "vitest";
import { INSTITUTE_COURSE_RULE_SKILLS, instituteCourseMatchSkill } from "./institute-course-skills";
import { getMatchSkill } from "./match-skills";

/** #2752 item 10 — a course name maps to one seeded match skill, by whole words, or to none. */
describe("instituteCourseMatchSkill", () => {
  it("names only seeded match skills, each with its own industry", () => {
    for (const skillId of INSTITUTE_COURSE_RULE_SKILLS) {
      expect(getMatchSkill(skillId), skillId).toBeDefined();
    }
  });

  it.each([
    ["CNC Programming", "mskill_cnc_programmer"],
    ["Mastercam", "mskill_cam_programmer"],
    ["SolidWorks", "mskill_cad_designer_3d"],
    ["CATIA V5", "mskill_cad_designer_3d"],
    ["Interior Design with SketchUp", "mskill_interior_designer"],
    ["AutoCAD", "mskill_designer"],
  ])("maps %s to %s", (course, skillId) => {
    expect(instituteCourseMatchSkill(course)).toEqual({
      skillId,
      industryId: getMatchSkill(skillId)!.industryId,
    });
  });

  it("takes the first rule a course names, so several courses map to the most advanced", () => {
    expect(instituteCourseMatchSkill("AutoCAD, SolidWorks")?.skillId).toBe(
      "mskill_cad_designer_3d",
    );
  });

  it("matches whole words, never substrings", () => {
    expect(instituteCourseMatchSkill("Campus Orientation")).toBeNull();
    expect(instituteCourseMatchSkill("Phoenix Batch")).toBeNull();
  });

  it("maps an unknown, empty or missing course to none", () => {
    expect(instituteCourseMatchSkill("Spoken English")).toBeNull();
    expect(instituteCourseMatchSkill("")).toBeNull();
    expect(instituteCourseMatchSkill(null)).toBeNull();
    expect(instituteCourseMatchSkill(undefined)).toBeNull();
  });
});

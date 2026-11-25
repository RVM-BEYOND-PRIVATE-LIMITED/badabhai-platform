import { describe, expect, it } from "vitest";
import {
  INSTITUTE_COURSE_RULE_SKILLS,
  instituteCourseMatchSkills,
} from "./institute-course-skills";
import { LIVE_POSTING_TRADE_KINDS } from "./posting-trades";
import { getMatchSkill } from "./match-skills";
import { TRADE_CATALOGUE } from "./trade-catalogue";

const ALL = new Set(TRADE_CATALOGUE.map((e) => e.roleKind));
const LIVE = new Set<string>(LIVE_POSTING_TRADE_KINDS);
const skills = (course: string | null | undefined, released: ReadonlySet<string> = ALL) =>
  instituteCourseMatchSkills(course, released).map((s) => s.skillId);

/** #2752 item 10, ruled by #3014 (pack 7.3) — a course string gives a list of seeded skills. */
describe("instituteCourseMatchSkills", () => {
  it("names only seeded match skills, each with its own industry", () => {
    for (const skillId of INSTITUTE_COURSE_RULE_SKILLS) {
      expect(getMatchSkill(skillId), skillId).toBeDefined();
    }
  });

  it.each([
    ["CNC", "mskill_cnc_turner"],
    ["VMC Operating + Setting", "mskill_vmc_operator"],
    ["Mastercam", "mskill_cam_programmer"],
    ["SolidWorks", "mskill_cad_designer_3d"],
    ["AutoCAD Mechanical", "mskill_designer"],
  ])("maps %s to %s with its industry", (course, skillId) => {
    expect(instituteCourseMatchSkills(course, ALL)).toEqual([
      { skillId, industryId: getMatchSkill(skillId)!.industryId },
    ]);
  });

  it("CNC is the CNC Turner, never the CNC Programmer (the old word rule)", () => {
    expect(skills("CNC")).toEqual(["mskill_cnc_turner"]);
    expect(skills("CNC Programming")).toEqual([]);
  });

  it("gives every course's skill, first listed first", () => {
    expect(skills("AutoCAD Mechanical, SolidWorks")).toEqual([
      "mskill_designer",
      "mskill_cad_designer_3d",
    ]);
    expect(skills("CNC, VMC")).toEqual(["mskill_cnc_turner", "mskill_vmc_operator"]);
  });

  it("matches whole course names, never words", () => {
    expect(skills("Campus Orientation")).toEqual([]);
    expect(skills("CATIA V5")).toEqual([]);
    expect(skills("Interior Design with SketchUp")).toEqual([]);
  });

  it("gives nothing for a course whose new trade companies cannot post yet", () => {
    expect(skills("Robotics", ALL)).toEqual(["mskill_robot_operator_programmer"]);
    expect(skills("Robotics", LIVE)).toEqual([]);
    expect(skills("ArtCAM, CNC", LIVE)).toEqual(["mskill_cnc_turner"]);
    // A skill live before v2 passes: the grant a SolidWorks student gets today is unchanged.
    expect(skills("SolidWorks", LIVE)).toEqual(["mskill_cad_designer_3d"]);
  });

  it("maps an unknown, label-only, empty or missing course to none", () => {
    expect(skills("Spoken English")).toEqual([]);
    expect(skills("Revit")).toEqual([]);
    expect(skills("")).toEqual([]);
    expect(skills(null)).toEqual([]);
    expect(skills(undefined)).toEqual([]);
  });
});

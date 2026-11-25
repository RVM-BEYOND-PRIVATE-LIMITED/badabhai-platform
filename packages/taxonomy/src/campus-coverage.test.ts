import { describe, expect, it } from "vitest";
import { campusCoverage, heldCampusRoles, heldRvmCourses } from "./campus-coverage";
import { LIVE_POSTING_TRADE_KINDS } from "./posting-trades";

const LIVE = new Set<string>(LIVE_POSTING_TRADE_KINDS);

/** A fixture: Campus jobs by title, RVM students by role and course. Names and counts only. */
const JOBS = [
  { roleTitle: "CNC Turner", jobs: 4 },
  { roleTitle: "CNC Operator", jobs: 3 },
  { roleTitle: "Senior CNC Operator", jobs: 2 },
  { roleTitle: "senior cnc  operator", jobs: 1 },
  { roleTitle: "Quality Engineer", jobs: 2 },
  { roleTitle: "Interior Designer", jobs: 1 },
  { roleTitle: null, jobs: 1 },
];
const STUDENTS = [
  { roleLabel: "Product Design Engineer", courses: "SolidWorks", students: 5 },
  { roleLabel: null, courses: "CNC, VMC", students: 4 },
  { roleLabel: "Senior CNC Operator", courses: "Spoken English", students: 2 },
  { roleLabel: null, courses: "ArtCAM", students: 1 },
  { roleLabel: null, courses: null, students: 3 },
];

describe("heldCampusRoles", () => {
  it("lists each held name once, most common spelling, jobs and students added, most first", () => {
    expect(heldCampusRoles(JOBS, STUDENTS, LIVE)).toEqual([
      {
        role_label: "Senior CNC Operator",
        count: 5,
        jobs: 3,
        students: 2,
        reason: "not_in_table",
      },
      {
        role_label: "Quality Engineer",
        count: 2,
        jobs: 2,
        students: 0,
        reason: "trade_switched_off",
      },
    ]);
  });

  it("drops a name once its trade is switched on", () => {
    const on = new Set([...LIVE, "quality_engineer"]);
    expect(heldCampusRoles(JOBS, [], on).map((r) => r.role_label)).toEqual(["Senior CNC Operator"]);
  });

  it("never lists a mapped, label-only or empty role", () => {
    const names = heldCampusRoles(JOBS, STUDENTS, LIVE).map((r) => r.role_label);
    for (const n of ["CNC Turner", "CNC Operator", "Interior Designer", "Product Design Engineer"]) {
      expect(names).not.toContain(n);
    }
  });
});

describe("heldRvmCourses", () => {
  it("lists held courses with how many students carry each", () => {
    expect(heldRvmCourses(STUDENTS, LIVE)).toEqual([
      { course_label: "Spoken English", count: 2, reason: "not_in_table" },
      { course_label: "ArtCAM", count: 1, reason: "trade_switched_off" },
    ]);
  });
});

describe("campusCoverage — the three numbers", () => {
  const open = new Map([
    ["mskill_cnc_turner", 6],
    ["mskill_cad_designer_3d", 2],
  ]);
  const out = campusCoverage(JOBS, STUDENTS, open, LIVE);

  it("1. Campus jobs with a trade (the general CNC skill counts)", () => {
    // CNC Turner 4 + CNC Operator 3, of 14.
    expect(out.campusJobsWithTrade).toEqual({ with: 7, of: 14, share: 0.5 });
  });

  it("2. RVM students with a trade from role or course", () => {
    // SolidWorks 5 + CNC/VMC 4, of 15.
    expect(out.rvmStudentsWithTrade).toEqual({ with: 9, of: 15, share: 0.6 });
  });

  it("3. RVM courses that reach their own trade's open jobs", () => {
    expect(out.courses).toEqual([
      { course_label: "SolidWorks", students: 5, skills: ["mskill_cad_designer_3d"], openJobs: 2 },
      { course_label: "CNC", students: 4, skills: ["mskill_cnc_turner"], openJobs: 6 },
      { course_label: "VMC", students: 4, skills: ["mskill_vmc_operator"], openJobs: 0 },
      { course_label: "Spoken English", students: 2, skills: [], openJobs: 0 },
      { course_label: "ArtCAM", students: 1, skills: [], openJobs: 0 },
    ]);
    expect(out.rvmCoursesReachingJobs).toEqual({ with: 2, of: 5, share: 0.4 });
  });

  it("answers a null share when there is nothing to count", () => {
    expect(campusCoverage([], [], new Map(), LIVE).campusJobsWithTrade).toEqual({
      with: 0,
      of: 0,
      share: null,
    });
  });
});

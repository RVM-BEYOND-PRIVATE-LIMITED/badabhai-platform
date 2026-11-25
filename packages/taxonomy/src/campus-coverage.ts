import {
  campusRoleTrade,
  normalizeCampusName,
  rvmCourseTrades,
  splitRvmCourses,
  type CampusHeldReason,
} from "./campus-trade-map";

/**
 * #3014 — the held list and the three coverage numbers, from NAMES AND COUNTS ONLY.
 *
 * Both readers (the admin route `GET admin/campus-roles/held` and `db:report:campus-coverage`)
 * group their rows in SQL first, so what reaches this file is a name and how many jobs or students
 * carry it — never a person, a company or a phone. Pure: no database, no clock.
 */

/** Campus-made job postings grouped by their title. */
export interface CampusJobRoleCount {
  readonly roleTitle: string | null;
  readonly jobs: number;
}

/** RVM students grouped by their Campus role and RVM course string. */
export interface RvmStudentGroup {
  readonly roleLabel: string | null;
  readonly courses: string | null;
  readonly students: number;
}

export interface HeldCampusRole {
  /** The most common original spelling of the name. */
  readonly role_label: string;
  /** Jobs + students carrying it. */
  readonly count: number;
  readonly jobs: number;
  readonly students: number;
  readonly reason: CampusHeldReason;
}

export interface HeldRvmCourse {
  readonly course_label: string;
  readonly count: number;
  readonly reason: CampusHeldReason;
}

/** Counts one name's spellings, so the label shown is the one used most. */
class Spellings {
  private readonly counts = new Map<string, number>();
  add(spelling: string, n: number): void {
    this.counts.set(spelling, (this.counts.get(spelling) ?? 0) + n);
  }
  best(): string {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  }
}

const byCount = <T extends { count: number }>(label: (t: T) => string) => (a: T, b: T) =>
  b.count - a.count || label(a).localeCompare(label(b));

/**
 * The distinct held Campus role names with their counts, most common first (pack 7.2: "put it on
 * the held list and send the name"). `postingEnabled` is the release switch.
 */
export function heldCampusRoles(
  jobs: readonly CampusJobRoleCount[],
  students: readonly RvmStudentGroup[],
  postingEnabled: ReadonlySet<string>,
): HeldCampusRole[] {
  const held = new Map<
    string,
    { spellings: Spellings; jobs: number; students: number; reason: CampusHeldReason }
  >();
  const add = (name: string | null, n: number, side: "jobs" | "students") => {
    if (typeof name !== "string" || n <= 0) return;
    const t = campusRoleTrade(name, { postingEnabled });
    if (t.kind !== "held") return;
    const key = normalizeCampusName(name);
    const entry = held.get(key) ?? {
      spellings: new Spellings(),
      jobs: 0,
      students: 0,
      reason: t.reason,
    };
    entry.spellings.add(name.trim().replace(/\s+/g, " "), n);
    entry[side] += n;
    held.set(key, entry);
  };
  for (const j of jobs) add(j.roleTitle, j.jobs, "jobs");
  for (const s of students) add(s.roleLabel, s.students, "students");
  return [...held.values()]
    .map((e) => ({
      role_label: e.spellings.best(),
      count: e.jobs + e.students,
      jobs: e.jobs,
      students: e.students,
      reason: e.reason,
    }))
    .sort(byCount((r) => r.role_label));
}

/** The distinct held RVM course names with how many students carry each, most common first. */
export function heldRvmCourses(
  students: readonly RvmStudentGroup[],
  postingEnabled: ReadonlySet<string>,
): HeldRvmCourse[] {
  const held = new Map<string, { spellings: Spellings; count: number; reason: CampusHeldReason }>();
  for (const s of students) {
    if (s.students <= 0) continue;
    for (const h of rvmCourseTrades(s.courses, postingEnabled).held) {
      const key = normalizeCampusName(h.course);
      const entry = held.get(key) ?? { spellings: new Spellings(), count: 0, reason: h.reason };
      entry.spellings.add(h.course, s.students);
      entry.count += s.students;
      held.set(key, entry);
    }
  }
  return [...held.values()]
    .map((e) => ({ course_label: e.spellings.best(), count: e.count, reason: e.reason }))
    .sort(byCount((r) => r.course_label));
}

export interface CampusCoverageShare {
  readonly with: number;
  readonly of: number;
  /** `with / of`, or null when `of` is 0. */
  readonly share: number | null;
}

export interface RvmCourseReach {
  readonly course_label: string;
  readonly students: number;
  /** The skills the course gives (released ones only). */
  readonly skills: readonly string[];
  /** Open jobs carrying one of those skills. */
  readonly openJobs: number;
}

export interface CampusCoverage {
  /** 1. Campus jobs whose role gives a trade (or the general CNC skill). */
  readonly campusJobsWithTrade: CampusCoverageShare;
  /** 2. RVM students whose role or course gives a trade. */
  readonly rvmStudentsWithTrade: CampusCoverageShare;
  /** 3. Distinct RVM courses that give a trade with at least one open job. */
  readonly rvmCoursesReachingJobs: CampusCoverageShare;
  readonly courses: readonly RvmCourseReach[];
}

const share = (w: number, of: number): CampusCoverageShare => ({
  with: w,
  of,
  share: of === 0 ? null : w / of,
});

/**
 * The three numbers Akshit asked for after Wave 1 (#3014 step 6). `openJobsBySkill` is the number
 * of open postings carrying each match skill.
 */
export function campusCoverage(
  jobs: readonly CampusJobRoleCount[],
  students: readonly RvmStudentGroup[],
  openJobsBySkill: ReadonlyMap<string, number>,
  postingEnabled: ReadonlySet<string>,
): CampusCoverage {
  const gives = (name: string | null): boolean => {
    const t = campusRoleTrade(name, { postingEnabled });
    return t.kind === "trade" || t.kind === "general_cnc";
  };

  let jobsWith = 0;
  let jobsAll = 0;
  for (const j of jobs) {
    jobsAll += j.jobs;
    if (gives(j.roleTitle)) jobsWith += j.jobs;
  }

  let studentsWith = 0;
  let studentsAll = 0;
  const courses = new Map<string, { spellings: Spellings; students: number; skills: Set<string> }>();
  for (const s of students) {
    studentsAll += s.students;
    const fromCourse = rvmCourseTrades(s.courses, postingEnabled);
    if (gives(s.roleLabel) || fromCourse.trades.length > 0) studentsWith += s.students;
    for (const course of splitRvmCourses(s.courses)) {
      const key = normalizeCampusName(course);
      const entry = courses.get(key) ?? {
        spellings: new Spellings(),
        students: 0,
        skills: new Set(rvmCourseTrades(course, postingEnabled).trades.map((t) => t.skillId)),
      };
      entry.spellings.add(course, s.students);
      entry.students += s.students;
      courses.set(key, entry);
    }
  }

  const reach: RvmCourseReach[] = [...courses.values()]
    .map((c) => ({
      course_label: c.spellings.best(),
      students: c.students,
      skills: [...c.skills].sort(),
      openJobs: [...c.skills].reduce((n, skill) => n + (openJobsBySkill.get(skill) ?? 0), 0),
    }))
    .sort((a, b) => b.students - a.students || a.course_label.localeCompare(b.course_label));

  return {
    campusJobsWithTrade: share(jobsWith, jobsAll),
    rvmStudentsWithTrade: share(studentsWith, studentsAll),
    rvmCoursesReachingJobs: share(reach.filter((c) => c.openJobs > 0).length, reach.length),
    courses: reach,
  };
}

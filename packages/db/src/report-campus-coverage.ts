/**
 * `db:report:campus-coverage` — how much of Campus the one Campus table reaches (#3014 step 6).
 *
 * The three numbers Akshit asked for after Wave 1:
 *   1. the share of Campus jobs with a trade;
 *   2. the share of RVM students with a trade;
 *   3. the share of RVM courses that reach their own trade's open jobs.
 * Then the held list (roles and courses), the list sent for a ruling.
 *
 * READ-ONLY: one `READ ONLY` transaction; it writes nothing, anywhere. NAMES AND COUNTS ONLY: every
 * read groups in SQL (`campus-coverage-reads.ts`), so no worker, company or phone is printed.
 * The translation is the live one: the Campus table (`@badabhai/taxonomy` campus-trade-map) and
 * the release switch as stored now.
 *
 * Run: `DATABASE_URL=… pnpm --filter @badabhai/db db:report:campus-coverage [--json=<path>]`.
 * A `--json` path that exists is refused: evidence is never overwritten.
 */
import { existsSync, writeFileSync } from "node:fs";

import {
  campusCoverage,
  heldCampusRoles,
  heldRvmCourses,
  type CampusCoverage,
  type CampusCoverageShare,
  type HeldCampusRole,
  type HeldRvmCourse,
} from "@badabhai/taxonomy";

import { createDbClient, type Database } from "./client";
import {
  readCampusJobRoleCounts,
  readOpenJobsBySkill,
  readPostingEnabledKinds,
  readRvmStudentGroups,
} from "./campus-coverage-reads";

const SCRIPT = "report:campus-coverage";

export interface CampusCoverageReport {
  readonly coverage: CampusCoverage;
  readonly heldRoles: readonly HeldCampusRole[];
  readonly heldCourses: readonly HeldRvmCourse[];
  readonly releasedKinds: readonly string[];
}

/** Every read, inside the caller's transaction. */
export async function buildCampusCoverageReport(tx: Database): Promise<CampusCoverageReport> {
  const jobs = await readCampusJobRoleCounts(tx);
  const students = await readRvmStudentGroups(tx);
  const openJobs = await readOpenJobsBySkill(tx);
  const released = await readPostingEnabledKinds(tx);
  return {
    coverage: campusCoverage(jobs, students, openJobs, released),
    heldRoles: heldCampusRoles(jobs, students, released),
    heldCourses: heldRvmCourses(students, released),
    releasedKinds: [...released].sort(),
  };
}

const pct = (s: CampusCoverageShare): string =>
  s.share === null ? `${s.with} of ${s.of} (n/a)` : `${s.with} of ${s.of} (${(s.share * 100).toFixed(1)}%)`;

/** The printed report. */
export function renderCampusCoverage(r: CampusCoverageReport): string[] {
  const c = r.coverage;
  const lines = [
    `# Campus coverage (#3014)`,
    "",
    `Release switch: ${r.releasedKinds.length} trade kinds posting-enabled.`,
    "",
    `1. Campus jobs with a trade:              ${pct(c.campusJobsWithTrade)}`,
    `2. RVM students with a trade:             ${pct(c.rvmStudentsWithTrade)}`,
    `3. RVM courses reaching their trade's jobs: ${pct(c.rvmCoursesReachingJobs)}`,
    "",
    `## RVM courses`,
    "",
    "| Course | Students | Skills | Open jobs |",
    "|---|---|---|---|",
    ...c.courses.map(
      (x) => `| ${x.course_label} | ${x.students} | ${x.skills.join(", ") || "none"} | ${x.openJobs} |`,
    ),
    "",
    `## Held Campus roles (${r.heldRoles.length})`,
    "",
    "| Role | Count | Jobs | Students | Reason |",
    "|---|---|---|---|---|",
    ...r.heldRoles.map(
      (x) => `| ${x.role_label} | ${x.count} | ${x.jobs} | ${x.students} | ${x.reason} |`,
    ),
    "",
    `## Held RVM courses (${r.heldCourses.length})`,
    "",
    "| Course | Students | Reason |",
    "|---|---|---|",
    ...r.heldCourses.map((x) => `| ${x.course_label} | ${x.count} | ${x.reason} |`),
  ];
  return lines;
}

async function main(): Promise<void> {
  const jsonArg = process.argv.slice(2).find((a) => a.startsWith("--json="));
  const jsonPath = jsonArg ? jsonArg.slice("--json=".length) : null;
  if (jsonPath && existsSync(jsonPath)) {
    throw new Error(`[${SCRIPT}] refusing to overwrite ${jsonPath}: evidence is never replaced`);
  }
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const report = await db.transaction(
      (tx) => buildCampusCoverageReport(tx as unknown as Database),
      { accessMode: "read only" },
    );
    for (const line of renderCampusCoverage(report)) console.log(line);
    if (jsonPath) {
      writeFileSync(jsonPath, `${JSON.stringify({ kind: "campus-coverage", ...report }, null, 2)}\n`);
      console.log(`\nevidence written to ${jsonPath}`);
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    const err = e as { message?: string; cause?: { message?: string } };
    console.error(err?.message ?? String(e));
    if (err?.cause?.message) console.error(`  cause: ${err.cause.message}`);
    process.exit(1);
  });
}

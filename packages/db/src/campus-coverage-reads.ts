import { sql } from "drizzle-orm";
import { LIVE_POSTING_TRADE_KINDS } from "@badabhai/taxonomy";
import type { CampusJobRoleCount, RvmStudentGroup } from "@badabhai/taxonomy";
import type { Database } from "./client";
import { tradeRelease } from "./schema";

/**
 * #3014 — the reads behind the Campus held list (`GET admin/campus-roles/held`) and
 * `db:report:campus-coverage`. READ-ONLY, and NAMES AND COUNTS ONLY: every query groups in SQL,
 * so no worker id, name, phone or company leaves the database through here.
 *
 * WHO IS WHAT.
 *   - A Campus job: a job posting Campus made (`audit_logs` action `campus_link.posting_created`
 *     on the posting, written by `CampusPostingsRepository.approveAsCreated`); its role is the
 *     posting's `role_title`.
 *   - An RVM student: a worker whose origin is the RVM institute (the student import) or who has
 *     an active RVM link (#2752). His Campus role is the import's `role_label` on his latest
 *     imported profile; his course is his active RVM link's `course`.
 */

export const CAMPUS_POSTING_CREATED_AUDIT_ACTION = "campus_link.posting_created";

/** Campus-made job postings, grouped by `role_title`. */
export async function readCampusJobRoleCounts(executor: Database): Promise<CampusJobRoleCount[]> {
  const rows = (await executor.execute(sql`
    SELECT jp.role_title AS role_title, count(*)::int AS n
    FROM job_postings jp
    WHERE EXISTS (
      SELECT 1 FROM audit_logs a
      WHERE a.entity_type = 'job_posting'
        AND a.entity_id = jp.id
        AND a.action = ${CAMPUS_POSTING_CREATED_AUDIT_ACTION}
    )
    GROUP BY jp.role_title
  `)) as unknown as { role_title: string | null; n: number }[];
  return rows.map((r) => ({ roleTitle: r.role_title, jobs: Number(r.n) }));
}

/** RVM students, grouped by their Campus role and RVM course. */
export async function readRvmStudentGroups(executor: Database): Promise<RvmStudentGroup[]> {
  const rows = (await executor.execute(sql`
    WITH students AS (
      SELECT w.id FROM workers w
      WHERE EXISTS (
          SELECT 1 FROM worker_origins o
          WHERE o.worker_id = w.id AND o.kind = 'institute' AND o.ref = 'rvm'
        )
        OR EXISTS (
          SELECT 1 FROM worker_institute_links l
          WHERE l.worker_id = w.id AND l.institute_code = 'rvm' AND l.status = 'active'
        )
    )
    SELECT role.role_label, link.course, count(*)::int AS n
    FROM students s
    LEFT JOIN LATERAL (
      SELECT p.raw_profile->>'role_label' AS role_label
      FROM worker_profiles p
      WHERE p.worker_id = s.id AND p.raw_profile->>'import_source' = 'campus'
      ORDER BY p.created_at DESC
      LIMIT 1
    ) role ON true
    LEFT JOIN LATERAL (
      SELECT l.course
      FROM worker_institute_links l
      WHERE l.worker_id = s.id AND l.institute_code = 'rvm' AND l.status = 'active'
      ORDER BY l.linked_at DESC
      LIMIT 1
    ) link ON true
    GROUP BY role.role_label, link.course
  `)) as unknown as { role_label: string | null; course: string | null; n: number }[];
  return rows.map((r) => ({ roleLabel: r.role_label, courses: r.course, students: Number(r.n) }));
}

/** Open job postings per match skill (`match_skill_ids`). */
export async function readOpenJobsBySkill(executor: Database): Promise<Map<string, number>> {
  const rows = (await executor.execute(sql`
    SELECT s.skill_id, count(DISTINCT jp.id)::int AS n
    FROM job_postings jp
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(jp.match_skill_ids) = 'array' THEN jp.match_skill_ids ELSE '[]'::jsonb END
    ) AS s(skill_id)
    WHERE jp.status = 'open'
    GROUP BY s.skill_id
  `)) as unknown as { skill_id: string; n: number }[];
  return new Map(rows.map((r) => [r.skill_id, Number(r.n)]));
}

/**
 * The kinds companies may post now: the same answer as the API's `TradeReleaseService`. A missing
 * `trade_release` table (migration 0198 not applied, SQLSTATE 42P01 only) reads as its seed, the
 * 16 live kinds. ANY OTHER error is thrown, never answered as "nothing released": the student
 * import would otherwise delete every imported student's trade skills on apply.
 */
export async function readPostingEnabledKinds(executor: Database): Promise<ReadonlySet<string>> {
  try {
    const rows = await executor
      .select({ roleKind: tradeRelease.roleKind, postingEnabled: tradeRelease.postingEnabled })
      .from(tradeRelease);
    return new Set(rows.filter((r) => r.postingEnabled).map((r) => r.roleKind));
  } catch (err) {
    if (sqlState(err) === "42P01") return new Set(LIVE_POSTING_TRADE_KINDS);
    throw err;
  }
}

/** The SQLSTATE on a postgres.js error, or on the error a Drizzle wrapper carries as `cause`. */
function sqlState(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

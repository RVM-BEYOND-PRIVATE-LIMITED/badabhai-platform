import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { jobPostings, type JobPostingAudience } from "./schema";

/**
 * #2746 — WHICH POSTINGS A BADABHAI WORKER MAY EVER SEE, by `job_postings.audience`.
 *
 * POSITIVE MEMBERSHIP, NOT `<> 'rvm_students'`. A fourth audience added to the CHECK later is
 * invisible to every BadaBhai worker until someone lists it here — a new audience fails closed,
 * never open. `badabhai_workers` is every posting that existed before migration 0162 and every
 * agency twin (`job_postings_twin_audience_chk`), so this predicate is TRUE for all of them and
 * no existing posting changes who sees it.
 */
export const BADABHAI_WORKER_AUDIENCES = [
  "badabhai_workers",
  "both",
] as const satisfies readonly JobPostingAudience[];

/**
 * The members as SQL literals. Literal rather than bound: the set is a closed, compile-time
 * vocabulary (the `satisfies` above pins every member to the CHECK's set), so the statement text
 * — and the parameter list every statement test pins — is the same wherever the fragment lands.
 */
const AUDIENCE_LITERALS = BADABHAI_WORKER_AUDIENCES.map((audience) => `'${audience}'`).join(", ");

/**
 * A SQL alias for `job_postings` in a raw statement (`jp`, or the bare table name). Checked, because
 * it is spliced into the statement text.
 */
const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * THE ONE SQL SPELLING of "a BadaBhai worker may see this posting", in two parts that are BOTH
 * required:
 *
 *   1. #2746, THE AUDIENCE: `<audience> IN ('badabhai_workers', 'both')`.
 *   2. #2891, THE CAMPUS HOLD: no `job_posting_worker_visibility` row for the posting says other
 *      than `on`. A Campus-origin posting is held there from the moment it exists until an admin
 *      opens it (ruling of 17 Nov 2026); while held it behaves exactly as an RVM-students-only
 *      posting. A posting with no row is not Campus-origin and passes this part. `<> 'on'`
 *      rather than `= 'off'`, so a state added to the CHECK later holds, never opens.
 *
 * Every worker read that tests `hidden_at` / `status = 'open'` puts this beside them, and the
 * reach materialization (`materializeJobReachWithin`, the worker reconcile) writes no
 * `job_reach` row where it is false. No other file may spell an audience literal
 * (`job-visibility.static.test.ts`). Like the audience, the hold has NO SWITCH: the table is read
 * unconditionally, so the migration that creates it is applied before this code deploys.
 *
 * The default renders `"job_postings"."audience"` / `"job_postings"."id"` and serves a drizzle
 * `.where(and(...))` over the unaliased table. A raw statement passes the alias it gave the table:
 * `reachesBadaBhaiWorkers("jp")`, or `reachesBadaBhaiWorkers("job_postings")` when it is unaliased.
 */
export function reachesBadaBhaiWorkers(alias?: string): SQL {
  const { audience, id } = postingColumns(alias);
  return sql`(${audience} IN (${sql.raw(AUDIENCE_LITERALS)}) AND NOT EXISTS (SELECT 1 FROM job_posting_worker_visibility jpwv WHERE jpwv.job_posting_id = ${id} AND jpwv.state <> 'on'))`;
}

function postingColumns(alias: string | undefined): { audience: SQLWrapper; id: SQLWrapper } {
  if (alias === undefined) return { audience: jobPostings.audience, id: jobPostings.id };
  if (!SQL_ALIAS.test(alias)) throw new Error(`reachesBadaBhaiWorkers: bad SQL alias ${alias}`);
  return { audience: sql.raw(`${alias}.audience`), id: sql.raw(`${alias}.id`) };
}

/** The column default: every posting before 0162, every agency twin, every chat-published job. */
export const DEFAULT_JOB_POSTING_AUDIENCE = "badabhai_workers" satisfies JobPostingAudience;

/**
 * The audiences with an RVM part: the placement team reviews it (`job_posting_institute_reviews`)
 * and RVM students see it once approved. Positive membership, like the list above.
 */
export const RVM_STUDENT_AUDIENCES = [
  "rvm_students",
  "both",
] as const satisfies readonly JobPostingAudience[];

/** An audience with an RVM part: what a Campus read may ever hold. */
export type RvmStudentAudience = (typeof RVM_STUDENT_AUDIENCES)[number];

const RVM_AUDIENCE_LITERALS = RVM_STUDENT_AUDIENCES.map((audience) => `'${audience}'`).join(", ");

/**
 * THE ONE SQL SPELLING of "this posting has an RVM part" (#2752 part E): `<audience> IN
 * ('rvm_students', 'both')`, the Campus side's twin of {@link reachesBadaBhaiWorkers}. Every
 * Campus read that tests `hidden_at` / `status = 'open'` puts this beside them; approval is a
 * separate test (`approvedForRvmStudents`). Same column default and raw-alias form as the worker
 * fragment.
 */
export function reachesRvmStudents(audience: SQLWrapper = jobPostings.audience): SQL {
  return sql`${audience} IN (${sql.raw(RVM_AUDIENCE_LITERALS)})`;
}

/**
 * The TypeScript twin of PART 1 of {@link reachesBadaBhaiWorkers} (the audience), for code that holds
 * a row rather than a statement (the write path, the zero-reach alert). Same list, so the two cannot
 * disagree. It does NOT see the Campus hold (#2891): it decides whether a reach REBUILD is worth
 * running, and the rebuild itself goes through the SQL fragment, which does.
 */
export function audienceReachesBadaBhaiWorkers(audience: JobPostingAudience): boolean {
  return (BADABHAI_WORKER_AUDIENCES as readonly JobPostingAudience[]).includes(audience);
}

/** Does this audience have an RVM part (a review row, a Campus listing)? */
export function audienceReachesRvmStudents(audience: JobPostingAudience): boolean {
  return (RVM_STUDENT_AUDIENCES as readonly JobPostingAudience[]).includes(audience);
}

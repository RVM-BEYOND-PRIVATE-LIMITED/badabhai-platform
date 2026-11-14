import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { audienceReachesRvmStudents } from "./job-visibility";
import {
  jobPostingInstituteReviews,
  jobPostings,
  type InstituteCode,
  type InstituteReviewState,
  type JobPostingAudience,
} from "./schema";

/**
 * #2746 — WHAT THE PLACEMENT TEAM APPROVED, AND WHETHER IT STILL HOLDS.
 *
 * A review decision counts for the content it saw and nothing else (owner ruling 2026-11-13). The
 * decision stores `content_hash`, and every read compares it with the hash of the posting NOW. A
 * company edit to anything an RVM student sees therefore un-approves the posting at once, even if
 * a writer forgets to reset the row: the reset is housekeeping, the comparison is the gate.
 *
 * ONE DEFINITION of the hash and of "approved", here. The payer and admin reads use them today; the
 * Campus approval (#2746 PR 5) stores {@link postingReviewContentHash} and the student-facing read
 * (#2752 Part E) filters on {@link approvedForRvmStudents}. A second spelling of either is how an
 * edited posting would reach students unreviewed.
 */

/** The institute an RVM audience is reviewed by (`INSTITUTE_CODES`); the review row's key half. */
export const RVM_INSTITUTE_CODE = "rvm" satisfies InstituteCode;
const RVM: InstituteCode = RVM_INSTITUTE_CODE;

/**
 * Bumped only with a change to the field list or the encoding. Every stored hash then stops
 * matching and every approved posting reads `pending` until re-reviewed, so treat a bump as a
 * re-review of the whole catalogue. Until #2746 PR 5 stores the first hash, the list is free.
 */
export const POSTING_REVIEW_CONTENT_VERSION = 1;

/**
 * EVERY FIELD AN RVM STUDENT SEES, keyed by its Campus name (`CampusPostingSchema`): the owner
 * ruling's list (title, description, requirements, benefits, pay, location, shift, experience,
 * vacancy, audience, targeting) plus `company`, because Campus shows the company's display label
 * (`company.name`) and on a posting that label is `org_label`.
 *
 * NOT HERE, ON PURPOSE: `status` (open/closed is lifecycle, not content), `needed_by`, `role_kind`,
 * the trade form, the skill sets and the hide state — Campus shows none of them. Course LABELS are
 * reference data (`rvm_targeting_options`), not posting content; the ids are here.
 *
 * `list: true` columns are jsonb arrays that may be NULL ("never stated") while Campus renders `[]`;
 * the hash reads them as `[]` so a NULL → `[]` edit, which no student can see, re-pends nothing.
 */
const REVIEW_CONTENT: readonly { key: string; column: AnyPgColumn; list?: true }[] = [
  { key: "company", column: jobPostings.orgLabel },
  { key: "title", column: jobPostings.roleTitle },
  { key: "description", column: jobPostings.description },
  { key: "location_label", column: jobPostings.locationLabel },
  { key: "city", column: jobPostings.city },
  { key: "state", column: jobPostings.state },
  { key: "area", column: jobPostings.area },
  { key: "pay_min", column: jobPostings.payMin },
  { key: "pay_max", column: jobPostings.payMax },
  { key: "pay_type", column: jobPostings.payType },
  { key: "vacancy_band", column: jobPostings.vacancyBand },
  { key: "shift", column: jobPostings.shift },
  { key: "experience_min", column: jobPostings.minExperienceYears },
  { key: "experience_max", column: jobPostings.maxExperienceYears },
  { key: "requirements", column: jobPostings.requirements, list: true },
  { key: "benefits", column: jobPostings.benefits, list: true },
  { key: "audience", column: jobPostings.audience },
  { key: "branch_ids", column: jobPostings.rvmBranchIds },
  { key: "course_ids", column: jobPostings.rvmCourseIds },
];

/** The `job_postings` columns the hash reads, for tests and reviewers. */
export const POSTING_REVIEW_CONTENT_COLUMNS: readonly string[] = REVIEW_CONTENT.map(
  ({ column }) => column.name,
);

/** A column of `table`, or of the raw alias a statement gave it. */
function columnOf(column: AnyPgColumn, alias: string | undefined): SQLWrapper {
  return alias === undefined
    ? column
    : sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
}

/**
 * THE CONTENT HASH: lower-case sha256 hex (`jpir_content_hash_chk`) of one canonical text.
 *
 * The text is `jsonb_build_object(...)::text`. jsonb output is canonical by construction — keys
 * sorted, one spacing, numbers normalised, strings escaped one way — and NULL-safe (a NULL is
 * `null`, never an empty string or a missing key), so the same content hashes the same in every
 * session and on every server. `convert_to(…, 'UTF8')` pins the byte encoding. Keys are literals
 * from the closed list above, so the statement text and its parameters are the same everywhere.
 *
 * The default reads the unaliased `job_postings` columns, for a drizzle query over that table; a
 * raw statement that aliases the table passes the alias (`postingReviewContentHash("jp")`).
 */
export function postingReviewContentHash(posting?: string): SQL {
  const fields = REVIEW_CONTENT.map(({ key, column, list }) => {
    const value = columnOf(column, posting);
    return sql`${sql.raw(`'${key}'`)}, ${list ? sql`COALESCE(${value}, '[]'::jsonb)` : value}`;
  });
  return sql`encode(sha256(convert_to(jsonb_build_object(${sql.raw(
    `'v', ${POSTING_REVIEW_CONTENT_VERSION}`,
  )}, ${sql.join(fields, sql`, `)})::text, 'UTF8')), 'hex')`;
}

/**
 * THE ONE PREDICATE "approved for RVM students": an RVM review row that is `approved` AND whose
 * stored hash equals the posting's hash now. Positive EXISTS, never `NOT EXISTS` / COALESCE: no row
 * is not approved, a rejected row is not approved, an approval of older content is not approved.
 *
 * Correlated on the posting's `id` (the unaliased table, or `posting` as a raw alias). The review
 * table gets its own alias inside, so the predicate composes beside a join on the same table.
 */
export function approvedForRvmStudents(posting?: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${jobPostingInstituteReviews} AS "rvm_approval"
    WHERE "rvm_approval"."job_posting_id" = ${columnOf(jobPostings.id, posting)}
      AND "rvm_approval"."institute_code" = ${sql.raw(`'${RVM}'`)}
      AND "rvm_approval"."state" = 'approved'
      AND "rvm_approval"."content_hash" = ${postingReviewContentHash(posting)})`;
}

/**
 * The review state as a reader must show it, over a query that LEFT JOINs the posting's RVM review
 * row (`review`: the unaliased `job_posting_institute_reviews`, or its raw alias):
 *   - NULL when there is no row;
 *   - `approved` only through {@link approvedForRvmStudents};
 *   - `rejected` while the rejection is for the content now;
 *   - `pending` otherwise — including a decision on content the company has since changed.
 */
export function rvmReviewStateNow(opts: { posting?: string; review?: string } = {}): SQL {
  const state = columnOf(jobPostingInstituteReviews.state, opts.review);
  const hash = columnOf(jobPostingInstituteReviews.contentHash, opts.review);
  return sql`CASE WHEN ${state} IS NULL THEN NULL
    WHEN ${approvedForRvmStudents(opts.posting)} THEN 'approved'
    WHEN ${state} = 'rejected' AND ${hash} = ${postingReviewContentHash(opts.posting)} THEN 'rejected'
    ELSE 'pending' END`;
}

/**
 * The posting's RVM review state from its audience and {@link rvmReviewStateNow}: `null` when the
 * audience has no RVM part (the row, if any, outlives a withdrawal but reviews nothing), and
 * `pending` for an RVM audience with no row (fail closed: no row is not approved).
 */
export function rvmReviewStateFor(
  audience: JobPostingAudience,
  stateNow: InstituteReviewState | null,
): InstituteReviewState | null {
  if (!audienceReachesRvmStudents(audience)) return null;
  return stateNow ?? "pending";
}

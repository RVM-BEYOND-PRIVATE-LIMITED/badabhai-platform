import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  POSTING_REVIEW_CONTENT_COLUMNS,
  POSTING_REVIEW_CONTENT_VERSION,
  approvedForRvmStudents,
  postingReviewContentHash,
  rvmReviewStateFor,
  rvmReviewStateNow,
} from "./job-review";
import { JOB_POSTING_AUDIENCES, jobPostingInstituteReviews, jobPostings } from "./schema";

/**
 * #2746 — the review content hash and the approved predicate, as statements. What Postgres computes
 * (the same hash for the same content; a different one when any listed field changes; the same one
 * when an unlisted field changes) is executed by apps/api `payer-job-audience.db.test.ts`, which CI
 * runs among the DB-backed gates.
 */

const dialect = new PgDialect();
const compile = (fragment: SQL) => dialect.sqlToQuery(fragment);

/** Owner ruling 2026-11-13 + `company` (Campus shows `company.name` = the posting's `org_label`). */
const STUDENT_VISIBLE_COLUMNS = [
  "org_label",
  "role_title",
  "description",
  "location_label",
  "city",
  "state",
  "area",
  "pay_min",
  "pay_max",
  "pay_type",
  "vacancy_band",
  "shift",
  "min_experience_years",
  "max_experience_years",
  "requirements",
  "benefits",
  "audience",
  "rvm_branch_ids",
  "rvm_course_ids",
];

/** Columns a student never sees: an edit to one must not re-pend an approval. */
const NOT_STUDENT_VISIBLE = [
  "status",
  "needed_by",
  "role_kind",
  "trade_level",
  "trade_answers",
  "match_skill_ids",
  "reach_skill_ids",
  "skill_phrases",
  "hidden_at",
  "verification_status",
  "updated_at",
];

describe("postingReviewContentHash", () => {
  it("reads exactly the student-visible columns", () => {
    expect([...POSTING_REVIEW_CONTENT_COLUMNS].sort()).toEqual([...STUDENT_VISIBLE_COLUMNS].sort());
    for (const column of NOT_STUDENT_VISIBLE) {
      expect(POSTING_REVIEW_CONTENT_COLUMNS).not.toContain(column);
    }
    // Every listed name is a real job_postings column.
    const real = new Set(Object.values(jobPostings).map((c) => (c as { name?: string }).name));
    for (const column of POSTING_REVIEW_CONTENT_COLUMNS)
      expect(real.has(column), column).toBe(true);
  });

  it("is sha256 hex over one canonical jsonb text, with no bound parameter", () => {
    const { sql: text, params } = compile(postingReviewContentHash());
    expect(text.startsWith("encode(sha256(convert_to(jsonb_build_object(")).toBe(true);
    expect(text.endsWith(")::text, 'UTF8')), 'hex')")).toBe(true);
    expect(text).toContain(`'v', ${POSTING_REVIEW_CONTENT_VERSION}`);
    expect(params).toEqual([]);
    // The unaliased default reads the job_postings table itself.
    expect(text).toContain(`'title', "job_postings"."role_title"`);
    expect(text).toContain(`'audience', "job_postings"."audience"`);
  });

  it("renders the same text on every call (no clock, no random, no session state)", () => {
    expect(compile(postingReviewContentHash()).sql).toBe(compile(postingReviewContentHash()).sql);
    expect(compile(postingReviewContentHash("jp")).sql).toBe(
      compile(postingReviewContentHash("jp")).sql,
    );
    expect(compile(postingReviewContentHash()).sql).not.toMatch(/now\(\)|random|current_/i);
  });

  it("reads NULL-able chip lists as [] (Campus renders [], so NULL → [] re-pends nothing)", () => {
    const { sql: text } = compile(postingReviewContentHash());
    expect(text).toContain(`'requirements', COALESCE("job_postings"."requirements", '[]'::jsonb)`);
    expect(text).toContain(`'benefits', COALESCE("job_postings"."benefits", '[]'::jsonb)`);
    // Scalars stay raw: NULL is `null` in jsonb, never an empty string.
    expect(text).toContain(`'description', "job_postings"."description"`);
  });

  it("renders a raw alias for an aliased statement", () => {
    const { sql: text } = compile(postingReviewContentHash("jp"));
    expect(text).toContain(`'title', "jp"."role_title"`);
    expect(text).toContain(`'branch_ids', "jp"."rvm_branch_ids"`);
    expect(text).not.toContain(`"job_postings"`);
  });
});

describe("approvedForRvmStudents — THE predicate", () => {
  it("is a positive EXISTS on an approved RVM row whose hash is the posting's hash now", () => {
    const { sql: text, params } = compile(approvedForRvmStudents());
    expect(
      text.startsWith(`EXISTS (SELECT 1 FROM "job_posting_institute_reviews" AS "rvm_approval"`),
    ).toBe(true);
    expect(text).toContain(`"rvm_approval"."job_posting_id" = "job_postings"."id"`);
    expect(text).toContain(`"rvm_approval"."institute_code" = 'rvm'`);
    expect(text).toContain(`"rvm_approval"."state" = 'approved'`);
    expect(text).toContain(
      `"rvm_approval"."content_hash" = ${compile(postingReviewContentHash()).sql}`,
    );
    expect(params).toEqual([]);
  });

  it("never fails open: no NOT EXISTS, no COALESCE on the decision, no OR", () => {
    const { sql: text } = compile(approvedForRvmStudents());
    const outsideHash = text.replace(compile(postingReviewContentHash()).sql, "<hash>");
    expect(outsideHash).not.toMatch(/NOT EXISTS|COALESCE|\bOR\b|IS NULL/i);
  });

  it("correlates on an alias when given one", () => {
    const { sql: text } = compile(approvedForRvmStudents("jp"));
    expect(text).toContain(`"rvm_approval"."job_posting_id" = "jp"."id"`);
    expect(text).toContain(compile(postingReviewContentHash("jp")).sql);
  });

  it("composes inside a drizzle select over job_postings", () => {
    const query = new QueryBuilder()
      .select({ id: jobPostings.id, approved: sql<boolean>`${approvedForRvmStudents()}` })
      .from(jobPostings)
      .where(eq(jobPostings.id, "22222222-2222-4222-8222-222222222222"))
      .toSQL();
    expect(query.sql).toContain(`EXISTS (SELECT 1 FROM "job_posting_institute_reviews"`);
    expect(query.params).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });
});

describe("rvmReviewStateNow", () => {
  it("approves only through the shared predicate, and rejects only for the content now", () => {
    const { sql: text } = compile(rvmReviewStateNow());
    expect(text).toContain(`WHEN ${compile(approvedForRvmStudents()).sql} THEN 'approved'`);
    expect(text).toContain(
      `WHEN "job_posting_institute_reviews"."state" = 'rejected' AND "job_posting_institute_reviews"."content_hash" = ${compile(postingReviewContentHash()).sql} THEN 'rejected'`,
    );
    expect(text).toContain(`WHEN "job_posting_institute_reviews"."state" IS NULL THEN NULL`);
    expect(text).toContain(`ELSE 'pending' END`);
    // No second spelling of "approved": the only 'approved' outside the predicate is the label.
    const withoutPredicate = text.replace(compile(approvedForRvmStudents()).sql, "<approved>");
    expect(withoutPredicate.match(/'approved'/g)).toHaveLength(1);
  });

  it("renders raw aliases for both tables", () => {
    const { sql: text } = compile(rvmReviewStateNow({ posting: "jp", review: "r" }));
    expect(text).toContain(`WHEN "r"."state" IS NULL THEN NULL`);
    expect(text).toContain(`"rvm_approval"."job_posting_id" = "jp"."id"`);
    expect(text).not.toContain(`"job_posting_institute_reviews"."state"`);
    expect(jobPostingInstituteReviews.state.name).toBe("state");
  });
});

describe("rvmReviewStateFor", () => {
  it.each(JOB_POSTING_AUDIENCES)(
    "%s: no RVM part is null; an RVM part with no row is pending",
    (a) => {
      const rvm = a !== "badabhai_workers";
      expect(rvmReviewStateFor(a, null)).toBe(rvm ? "pending" : null);
      expect(rvmReviewStateFor(a, "approved")).toBe(rvm ? "approved" : null);
      expect(rvmReviewStateFor(a, "rejected")).toBe(rvm ? "rejected" : null);
    },
  );
});

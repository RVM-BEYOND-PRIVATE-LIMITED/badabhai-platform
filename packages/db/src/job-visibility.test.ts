import { and, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  BADABHAI_WORKER_AUDIENCES,
  DEFAULT_JOB_POSTING_AUDIENCE,
  RVM_STUDENT_AUDIENCES,
  audienceReachesBadaBhaiWorkers,
  audienceReachesRvmStudents,
  reachesBadaBhaiWorkers,
} from "./job-visibility";
import { JOB_POSTING_AUDIENCES, jobPostings, type JobPostingAudience } from "./schema";

/**
 * #2746 — the audience fragment renders the same membership in every context it lands in: a
 * drizzle `.where(and(...))` over the unaliased table, and a raw `db.execute(sql`...`)` statement
 * that aliases `job_postings` as `jp`. What Postgres does with it is the DB-gated suites' claim
 * (`materialize-job-reach.db.test.ts`, apps/api `job-audience-visibility.db.test.ts`).
 */

const dialect = new PgDialect();
const compile = (fragment: SQL) => dialect.sqlToQuery(fragment);

/**
 * EVERY audience the CHECK admits, with whether a BadaBhai worker may see it. Keyed by the full
 * closed set, so a fourth audience added to `JOB_POSTING_AUDIENCES` fails to compile here until
 * someone decides it — and the positive list then fails closed until they add it there too.
 */
const WORKER_VISIBLE: Record<JobPostingAudience, boolean> = {
  badabhai_workers: true,
  rvm_students: false,
  both: true,
};

describe("BADABHAI_WORKER_AUDIENCES", () => {
  it("is exactly the audiences decided visible to a BadaBhai worker", () => {
    expect([...BADABHAI_WORKER_AUDIENCES].sort()).toEqual(
      JOB_POSTING_AUDIENCES.filter((audience) => WORKER_VISIBLE[audience]).sort(),
    );
  });

  it("never lists rvm_students, and every member is a real audience", () => {
    expect(BADABHAI_WORKER_AUDIENCES).not.toContain("rvm_students");
    for (const audience of BADABHAI_WORKER_AUDIENCES) {
      expect(JOB_POSTING_AUDIENCES).toContain(audience);
    }
  });

  it("covers the column default, so every pre-0162 posting and every agency twin stays visible", () => {
    expect(jobPostings.audience.default).toBe("badabhai_workers");
    expect(BADABHAI_WORKER_AUDIENCES).toContain(jobPostings.audience.default);
  });
});

describe("reachesBadaBhaiWorkers", () => {
  it("defaults to the job_postings column and is positive membership, never a negation", () => {
    const { sql: text, params } = compile(reachesBadaBhaiWorkers());
    expect(text).toBe(`"job_postings"."audience" IN ('badabhai_workers', 'both')`);
    // Literal, not bound: the closed set adds no parameter wherever the fragment lands.
    expect(params).toEqual([]);
    expect(text).not.toMatch(/<>|!=|NOT IN/i);
  });

  it("renders a raw alias verbatim for an aliased raw statement", () => {
    const { sql: text, params } = compile(reachesBadaBhaiWorkers(sql`jp.audience`));
    expect(text).toBe(`jp.audience IN ('badabhai_workers', 'both')`);
    expect(params).toEqual([]);
  });

  it("composes inside a drizzle .where(and(...)) without moving the other bindings", () => {
    const query = new QueryBuilder()
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(eq(jobPostings.status, "open"), reachesBadaBhaiWorkers()))
      .toSQL();
    expect(query.sql).toContain(
      `("job_postings"."status" = $1 and "job_postings"."audience" IN ('badabhai_workers', 'both'))`,
    );
    expect(query.params).toEqual(["open"]);
  });

  it("composes inside a raw db.execute template beside bound values", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const { sql: text, params } = compile(sql`
      SELECT 1 FROM job_postings jp
      WHERE jp.id = ${id}::uuid AND ${reachesBadaBhaiWorkers(sql`jp.audience`)}
    `);
    expect(text).toContain(
      `WHERE jp.id = $1::uuid AND jp.audience IN ('badabhai_workers', 'both')`,
    );
    expect(params).toEqual([id]);
  });

  it("lists exactly BADABHAI_WORKER_AUDIENCES — the literal and the constant cannot drift", () => {
    const { sql: text } = compile(reachesBadaBhaiWorkers(sql`a`));
    const listed = /^a IN \((.*)\)$/.exec(text)?.[1]?.split(", ") ?? [];
    expect(listed).toEqual(BADABHAI_WORKER_AUDIENCES.map((audience) => `'${audience}'`));
  });
});

/** #2746 PR 4 — who has an RVM part (a review row and a Campus listing), decided per audience. */
const RVM_PART: Record<JobPostingAudience, boolean> = {
  badabhai_workers: false,
  rvm_students: true,
  both: true,
};

describe("the TypeScript twins of the rule", () => {
  it.each(JOB_POSTING_AUDIENCES)("%s: the twin answers what the SQL fragment's list says", (a) => {
    expect(audienceReachesBadaBhaiWorkers(a)).toBe(WORKER_VISIBLE[a]);
    expect(audienceReachesBadaBhaiWorkers(a)).toBe(
      (BADABHAI_WORKER_AUDIENCES as readonly string[]).includes(a),
    );
    expect(audienceReachesRvmStudents(a)).toBe(RVM_PART[a]);
  });

  it("RVM_STUDENT_AUDIENCES is exactly the audiences with an RVM part", () => {
    expect([...RVM_STUDENT_AUDIENCES].sort()).toEqual(
      JOB_POSTING_AUDIENCES.filter((audience) => RVM_PART[audience]).sort(),
    );
  });

  it("every audience reaches somebody, and the default is the column's", () => {
    for (const a of JOB_POSTING_AUDIENCES) {
      expect(audienceReachesBadaBhaiWorkers(a) || audienceReachesRvmStudents(a), a).toBe(true);
    }
    expect(DEFAULT_JOB_POSTING_AUDIENCE).toBe(jobPostings.audience.default);
    expect(audienceReachesRvmStudents(DEFAULT_JOB_POSTING_AUDIENCE)).toBe(false);
  });

  it("an unknown value is in neither list (a cast cannot open a path)", () => {
    const unknown = "everyone" as JobPostingAudience;
    expect(audienceReachesBadaBhaiWorkers(unknown)).toBe(false);
    expect(audienceReachesRvmStudents(unknown)).toBe(false);
  });
});

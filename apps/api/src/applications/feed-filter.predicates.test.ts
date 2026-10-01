import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { jobs, jobPostings } from "@badabhai/db";
import { feedPayFloorPredicate, feedShiftPredicate } from "./feed-filter.predicates";

/**
 * #1905 — the shift / pay-floor `/feed` predicates, rendered with the real `PgDialect`.
 *
 * STRUCTURAL, like applications.repository.test.ts and match-feed.repository.test.ts: the
 * predicate is compiled and its TEXT and BOUND PARAMETERS asserted. Nothing here proves
 * Postgres agrees over real rows; no DB-gated suite covers the legacy feed's filters yet (a
 * disclosed gap). What IS provable without a database is that the statement says the V1 rule:
 *
 *   shift    (shift IS NULL OR shift = :shift)
 *   pay_min  (pay_max IS NULL OR pay_max >= :payMin)
 *
 * The NULL arm is what keeps a job with an unstated shift or an open-ended band in the deck
 * (ADR-0036 Part 3). Losing it is a one-token diff that every mocked service test survives.
 */

const dialect = new PgDialect();
const compile = (node: SQL | undefined): { sql: string; params: unknown[] } => {
  const q = dialect.sqlToQuery(sql`${node}`);
  return { sql: q.sql.replace(/\s+/g, " "), params: q.params };
};

describe("feedShiftPredicate", () => {
  it("is ABSENT when the worker sent no shift (filters default OFF)", () => {
    expect(feedShiftPredicate(jobs.shift, undefined)).toBeUndefined();
  });

  it("keeps a job with a NULL shift, and otherwise matches the shift exactly", () => {
    const { sql: text, params } = compile(feedShiftPredicate(jobs.shift, "night"));
    expect(text).toBe('("jobs"."shift" is null or "jobs"."shift" = $1)');
    // Bound, never inlined.
    expect(params).toEqual(["night"]);
  });

  it("applies the IDENTICAL rule to `job_postings` (the #1823 postings arm)", () => {
    const { sql: text, params } = compile(feedShiftPredicate(jobPostings.shift, "day"));
    expect(text).toBe('("job_postings"."shift" is null or "job_postings"."shift" = $1)');
    expect(params).toEqual(["day"]);
  });
});

describe("feedPayFloorPredicate", () => {
  it("is ABSENT when the worker sent no pay floor (filters default OFF)", () => {
    expect(feedPayFloorPredicate(jobs.payMax, undefined)).toBeUndefined();
  });

  it("keeps an open-ended band (NULL pay_max), and otherwise compares the TOP of the band, inclusive", () => {
    const { sql: text, params } = compile(feedPayFloorPredicate(jobs.payMax, 20000));
    expect(text).toBe('("jobs"."pay_max" is null or "jobs"."pay_max" >= $1)');
    expect(params).toEqual([20000]);
  });

  it("never compares the floor against the BOTTOM of the band", () => {
    // A worker asking for >= 20000 must still see an 18000-25000 job: it CAN pay him what
    // he asked. `pay_min >= :floor` would hide it. V1 pins the same thing.
    const { sql: text } = compile(feedPayFloorPredicate(jobs.payMax, 20000));
    expect(text).not.toContain("pay_min");
  });

  it("treats 0 as a real floor (applied, excludes nothing), not as 'absent'", () => {
    // V1 tests the PARAMETER for NULL, not for falsiness. A truthiness check here would be a
    // quiet divergence between the two arms, harmless today only because pay_max >= 0 holds.
    const { sql: text, params } = compile(feedPayFloorPredicate(jobs.payMax, 0));
    expect(text).toContain('"jobs"."pay_max" >= $1');
    expect(params).toEqual([0]);
  });

  it("applies the IDENTICAL rule to `job_postings` (the #1823 postings arm)", () => {
    const { sql: text } = compile(feedPayFloorPredicate(jobPostings.payMax, 15000));
    expect(text).toBe('("job_postings"."pay_max" is null or "job_postings"."pay_max" >= $1)');
  });
});

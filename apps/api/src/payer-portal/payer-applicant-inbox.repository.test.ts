import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import {
  PayerApplicantInboxRepository,
  inboxPageStatement,
  type InboxPageQuery,
} from "./payer-applicant-inbox.repository";

/**
 * STRUCTURAL pins for the inbox page read (the `match-feed.repository.test.ts` house pattern):
 * the raw statement is compiled with the real `PgDialect` and asserted on its TEXT and BOUND
 * PARAMETERS. Every consumer fakes this repository, so a lost ownership predicate or a lost
 * membership conjunct would pass every other unit suite. Whether Postgres EVALUATES it the way it
 * reads is `payer-applicant-inbox.db.test.ts` (RUN_DB_TESTS=1).
 */

const dialect = new PgDialect();
const PAYER = "aaaaaaaa-0000-4000-8000-00000000000a";
const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const AFTER = {
  appliedKey: "2026-10-01T10:00:00.000007Z",
  applicationId: "44444444-4444-4444-8444-000000000007",
};

function compile(query: InboxPageQuery) {
  const q = dialect.sqlToQuery(inboxPageStatement(PAYER, query));
  return { sql: q.sql.replace(/\s+/g, " "), params: q.params };
}

/** The two arms, split at the UNION (agency first, company second). */
function arms(sql: string): { agency: string; company: string } {
  const at = sql.indexOf("UNION ALL");
  expect(at, "the statement is a UNION ALL of two arms").toBeGreaterThan(-1);
  return { agency: sql.slice(0, at), company: sql.slice(at) };
}

/** `$n` placeholders whose bound value is `value`. */
function placeholdersOf(params: unknown[], value: unknown): string[] {
  return params.flatMap((p, i) => (p === value ? [`$${i + 1}`] : []));
}

describe("inboxPageStatement — ownership is the SESSION payer, in both arms (XB-A)", () => {
  it("the agency arm reads jobs WHERE j.payer_id = the payer", () => {
    const { sql, params } = compile({ limit: 21 });
    const [p] = placeholdersOf(params, PAYER);
    expect(arms(sql).agency).toContain(`FROM jobs j INNER JOIN applications a ON a.job_id = j.id`);
    expect(arms(sql).agency).toContain(`WHERE j.payer_id = ${p}::uuid`);
  });

  it("the company arm reads job_postings WHERE jp.payer_id = the payer", () => {
    const { sql, params } = compile({ limit: 21 });
    const ps = placeholdersOf(params, PAYER);
    expect(arms(sql).company).toContain(
      `FROM job_postings jp INNER JOIN applications a ON a.job_posting_id = jp.id`,
    );
    expect(arms(sql).company).toContain(`WHERE jp.payer_id = ${ps[1]}::uuid`);
  });

  it("the payer is bound three times (two arms + the precedence probe) and nothing else is a payer", () => {
    const { params } = compile({ limit: 21 });
    expect(placeholdersOf(params, PAYER)).toHaveLength(3);
    expect(params).toEqual([PAYER, PAYER, PAYER, 21]);
  });

  it("payer_id is never projected", () => {
    const { sql } = compile({ limit: 21 });
    const outer = sql.slice(0, sql.indexOf(" FROM (")).trim();
    expect(outer).toBe(
      "SELECT p.application_id, p.worker_id, p.applied_key, p.posting_kind, p.posting_id, p.posting_title",
    );
    for (const arm of Object.values(arms(sql))) {
      const select = arm.slice(arm.indexOf("SELECT"), arm.indexOf(" FROM "));
      expect(select).not.toMatch(/payer_id|phone|name|email|org_label/);
    }
  });
});

describe("inboxPageStatement — membership is each per-posting list's", () => {
  it("both arms: applied only, and the ADR-0031 (b) freeze through an INNER workers join", () => {
    const { sql } = compile({ limit: 21 });
    for (const arm of Object.values(arms(sql))) {
      expect(arm).toContain("AND a.action = 'applied'");
      expect(arm).toContain("INNER JOIN workers w ON w.id = a.worker_id");
      expect(arm).toContain("AND w.deletion_scheduled_at IS NULL");
    }
  });

  it("agency arm: an applier needs a worker_profiles row (the per-job list ranks FROM worker_profiles)", () => {
    const { sql } = compile({ limit: 21 });
    expect(arms(sql).agency).toContain(
      "AND EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.worker_id = a.worker_id)",
    );
    expect(arms(sql).company).not.toContain("worker_profiles");
  });

  it("company arm: an application on one of the payer's OWN jobs belongs to the agency arm (listed once)", () => {
    const { sql, params } = compile({ limit: 21 });
    const p = placeholdersOf(params, PAYER)[2];
    expect(arms(sql).company).toContain(
      `AND NOT EXISTS ( SELECT 1 FROM jobs oj WHERE oj.id = a.job_id AND oj.payer_id = ${p}::uuid )`,
    );
  });
});

describe("inboxPageStatement — order, keyset, filter, limit", () => {
  it("orders newest application first, the application id as the total-order tiebreak", () => {
    const { sql, params } = compile({ limit: 21 });
    expect(sql.slice(sql.lastIndexOf("ORDER BY")).trim()).toBe(
      `ORDER BY p.created_at DESC, p.application_id DESC LIMIT $${params.length}`,
    );
  });

  it("the keyset value is microsecond UTC text, in both arms", () => {
    const { sql } = compile({ limit: 21 });
    for (const arm of Object.values(arms(sql))) {
      expect(arm).toContain(
        `to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_key`,
      );
    }
  });

  it("no cursor → no keyset predicate; a cursor → the same row comparison in EACH arm", () => {
    expect(compile({ limit: 21 }).sql).not.toContain("(a.created_at, a.id) <");
    const { sql, params } = compile({ limit: 21, after: AFTER });
    const t = placeholdersOf(params, AFTER.appliedKey);
    const id = placeholdersOf(params, AFTER.applicationId);
    expect(t).toHaveLength(2);
    expect(id).toHaveLength(2);
    expect(arms(sql).agency).toContain(
      `AND (a.created_at, a.id) < (${t[0]}::timestamptz, ${id[0]}::uuid)`,
    );
    expect(arms(sql).company).toContain(
      `AND (a.created_at, a.id) < (${t[1]}::timestamptz, ${id[1]}::uuid)`,
    );
  });

  it("no postingId → unfiltered; a postingId → filtered in EACH arm (it may name either table)", () => {
    const plain = compile({ limit: 21 }).sql;
    expect(plain).not.toContain("AND j.id =");
    expect(plain).not.toContain("AND jp.id =");
    const { sql, params } = compile({ limit: 21, postingId: POSTING });
    const p = placeholdersOf(params, POSTING);
    expect(p).toHaveLength(2);
    expect(arms(sql).agency).toContain(`AND j.id = ${p[0]}::uuid`);
    expect(arms(sql).company).toContain(`AND jp.id = ${p[1]}::uuid`);
  });

  it("binds the limit it is given (the service asks for page + 1)", () => {
    const { params } = compile({ limit: 51 });
    expect(params.at(-1)).toBe(51);
  });
});

describe("PayerApplicantInboxRepository.listPage — row mapping", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    application_id: "44444444-4444-4444-8444-000000000001",
    worker_id: "33333333-3333-4333-8333-000000000001",
    applied_key: "2026-10-01T10:00:00.000001Z",
    posting_kind: "company_posting",
    posting_id: POSTING,
    posting_title: "Turner (Fanuc)",
    ...over,
  });
  const repo = (rows: unknown[]) =>
    new PayerApplicantInboxRepository({ execute: async () => rows } as unknown as Database);

  it("maps the page row through", async () => {
    await expect(repo([raw()]).listPage(PAYER, { limit: 2 })).resolves.toEqual([
      {
        applicationId: "44444444-4444-4444-8444-000000000001",
        workerId: "33333333-3333-4333-8333-000000000001",
        appliedKey: "2026-10-01T10:00:00.000001Z",
        postingKind: "company_posting",
        postingId: POSTING,
        postingTitle: "Turner (Fanuc)",
      },
    ]);
  });

  it("executes exactly the pinned statement", async () => {
    let seen: SQL | undefined;
    const db = { execute: async (s: SQL) => ((seen = s), []) } as unknown as Database;
    await new PayerApplicantInboxRepository(db).listPage(PAYER, { limit: 3, postingId: POSTING });
    expect(dialect.sqlToQuery(seen!)).toEqual(
      dialect.sqlToQuery(inboxPageStatement(PAYER, { limit: 3, postingId: POSTING })),
    );
  });

  it("an unknown posting kind is a statement defect: it throws rather than guessing a shape", async () => {
    await expect(
      repo([raw({ posting_kind: "other" })]).listPage(PAYER, { limit: 2 }),
    ).rejects.toThrow(/unexpected posting kind/);
  });
});

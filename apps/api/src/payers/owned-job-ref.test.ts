import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { jobs, jobPostings, type Database } from "@badabhai/db";
import { findOwnedJobRef } from "./owned-job-ref";

/**
 * #1899 — STRUCTURAL test for the shared ownership query (the `unlocks.repository.test.ts`
 * pattern): capture each Drizzle select and compile its WHERE with the real `PgDialect`, so the
 * test proves the SQL is scoped by BOTH the id and the payer — the property the authz rests on.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const REF = "cccccccc-0000-4000-8000-000000000003";
const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";

interface SelectCall {
  table?: unknown;
  selection: Record<string, unknown>;
  where?: unknown;
  limit?: number;
}

/** A db whose `jobs` / `job_postings` selects resolve to the given rows, capturing each chain. */
function makeDb(rows: { jobs?: unknown[]; postings?: unknown[] }) {
  const calls: SelectCall[] = [];
  const db = {
    select: (selection: Record<string, unknown>) => {
      const call: SelectCall = { selection };
      calls.push(call);
      const node = {
        from: (t: unknown) => ((call.table = t), node),
        where: (w: unknown) => ((call.where = w), node),
        limit: async (n: number) => {
          call.limit = n;
          return (call.table === jobs ? rows.jobs : rows.postings) ?? [];
        },
      };
      return node;
    },
  };
  return { db: db as unknown as Database, calls };
}

describe("findOwnedJobRef — #1899 payer-scoped job / posting ownership", () => {
  it("scopes BOTH reads by id AND payer_id, projects the id only, limit 1", async () => {
    const { db, calls } = makeDb({});
    await findOwnedJobRef(db, REF, PAYER);

    expect(calls.map((c) => c.table)).toEqual([jobs, jobPostings]);
    const [jobCall, postingCall] = calls;
    expect(compile(jobCall!.where)).toEqual({
      sql: '("jobs"."id" = $1 and "jobs"."payer_id" = $2)',
      params: [REF, PAYER],
      typings: expect.anything(),
    });
    expect(compile(postingCall!.where)).toEqual({
      sql: '("job_postings"."id" = $1 and "job_postings"."payer_id" = $2)',
      params: [REF, PAYER],
      typings: expect.anything(),
    });
    for (const c of calls) {
      expect(Object.keys(c.selection)).toEqual(["id"]);
      expect(c.limit).toBe(1);
    }
  });

  it("an owned jobs row resolves to kind 'job'", async () => {
    const { db } = makeDb({ jobs: [{ id: REF }] });
    expect(await findOwnedJobRef(db, REF, PAYER)).toEqual({ kind: "job", id: REF });
  });

  it("an owned posting resolves to kind 'posting'", async () => {
    const { db } = makeDb({ postings: [{ id: REF }] });
    expect(await findOwnedJobRef(db, REF, PAYER)).toEqual({ kind: "posting", id: REF });
  });

  it("no owned row (unknown or another payer's — the query cannot tell) is null", async () => {
    const { db } = makeDb({});
    expect(await findOwnedJobRef(db, REF, PAYER)).toBeNull();
  });

  it("a read error propagates (fail closed)", async () => {
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => Promise.reject(new Error("db down")) }) }),
      }),
    } as unknown as Database;
    await expect(findOwnedJobRef(db, REF, PAYER)).rejects.toThrow("db down");
  });
});

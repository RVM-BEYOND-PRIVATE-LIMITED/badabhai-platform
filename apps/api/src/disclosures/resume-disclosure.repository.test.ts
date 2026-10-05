import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { jobPostings, type Database } from "@badabhai/db";
import { ResumeDisclosureRepository } from "./resume-disclosure.repository";

/**
 * #1898 — the posting-context probe behind the disclosure's context normalisation. The service
 * suite fakes this repository, so the read's shape is pinned here: `job_postings` by primary key,
 * the id only, no status filter (the FK needs the row to exist, not to be open).
 */

const dialect = new PgDialect();
const POSTING = "77777777-7777-4777-8777-777777777777";

function makeDb(rows: unknown[]) {
  const captured: { selection?: Record<string, unknown>; table?: unknown; where?: unknown } = {};
  let limit: number | undefined;
  const db = {
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      return {
        from: (table: unknown) => {
          captured.table = table;
          return {
            where: (cond: unknown) => {
              captured.where = cond;
              return {
                limit: (n: number) => {
                  limit = n;
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, captured, limit: () => limit };
}

describe("ResumeDisclosureRepository.jobPostingExists — #1898, reads job_postings by id only", () => {
  it("selects ONLY job_postings.id, by primary key, limit 1 — no status filter, no other table", async () => {
    const { db, captured, limit } = makeDb([{ id: POSTING }]);
    const out = await new ResumeDisclosureRepository(db).jobPostingExists(POSTING);
    expect(captured.table).toBe(jobPostings);
    expect(Object.keys(captured.selection!)).toEqual(["id"]);
    const q = dialect.sqlToQuery(captured.where as SQL);
    expect(q.sql).toBe('"job_postings"."id" = $1');
    expect(q.params).toEqual([POSTING]);
    expect(limit()).toBe(1);
    expect(out).toBe(true);
  });

  it("is false when no job_postings row has that id (e.g. an agency jobs id)", async () => {
    const { db } = makeDb([]);
    expect(await new ResumeDisclosureRepository(db).jobPostingExists(POSTING)).toBe(false);
  });
});

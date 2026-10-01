import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { jobPostings, type Database } from "@badabhai/db";
import { JobPostingsRepository } from "./job-postings.repository";

/**
 * STRUCTURAL pin for the payer owner-scoped posting read (XB-A horizontal authz).
 *
 * `findByIdAndPayer` is the ONE ownership check behind every payer posting route and, since
 * #1823, the payer applicant list's posting branch. The service tests fake this repository,
 * so the claim "a payer cannot read another payer's posting" lives only in this WHERE. These
 * tests capture the Drizzle chain (the reach.repository.test.ts pattern) and compile it, so a
 * refactor that drops the `payer_id` predicate fails here instead of in production.
 */

const dialect = new PgDialect();

const POSTING = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const PAYER = "aaaaaaaa-0000-4000-8000-00000000000a";

function makeDb(rows: unknown[]) {
  const captured: { from?: unknown; where?: unknown; limit?: number } = {};
  const db = {
    select: () => ({
      from: (table: unknown) => {
        captured.from = table;
        return {
          where: (cond: unknown) => {
            captured.where = cond;
            return {
              limit: (n: number) => {
                captured.limit = n;
                return Promise.resolve(rows);
              },
            };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, captured };
}

describe("JobPostingsRepository.findByIdAndPayer — ownership lives in the WHERE", () => {
  it("reads job_postings by id AND the session payer, binding exactly those two values", async () => {
    const { db, captured } = makeDb([]);
    await new JobPostingsRepository(db).findByIdAndPayer(POSTING, PAYER);
    expect(captured.from).toBe(jobPostings);
    const q = dialect.sqlToQuery(captured.where as SQL);
    expect(q.sql).toBe('("job_postings"."id" = $1 and "job_postings"."payer_id" = $2)');
    expect(q.params).toEqual([POSTING, PAYER]);
    expect(captured.limit).toBe(1);
  });

  it("no row (unknown id OR another payer's id) → undefined, the input to the neutral 404", async () => {
    const { db } = makeDb([]);
    await expect(new JobPostingsRepository(db).findByIdAndPayer(POSTING, PAYER)).resolves.toBe(
      undefined,
    );
  });
});

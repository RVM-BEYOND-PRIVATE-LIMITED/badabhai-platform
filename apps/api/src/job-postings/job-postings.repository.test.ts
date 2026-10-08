import "reflect-metadata";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { jobPostings, type Database } from "@badabhai/db";
import { JobPostingsRepository } from "./job-postings.repository";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { ownTenantKey } from "../payers/payer-tenant-scope.test-support";

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

/** The session payer's tenant key, minted by the REAL resolver in the default mode (ADR-0053). */
let PAYER_KEY: TenantKey;
beforeAll(async () => {
  PAYER_KEY = await ownTenantKey(PAYER);
});

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
    await new JobPostingsRepository(db).findByIdAndPayer(POSTING, PAYER_KEY);
    expect(captured.from).toBe(jobPostings);
    const q = dialect.sqlToQuery(captured.where as SQL);
    expect(q.sql).toBe('("job_postings"."id" = $1 and "job_postings"."payer_id" = $2)');
    expect(q.params).toEqual([POSTING, PAYER]);
    expect(captured.limit).toBe(1);
  });

  it("no row (unknown id OR another payer's id) → undefined, the input to the neutral 404", async () => {
    const { db } = makeDb([]);
    await expect(new JobPostingsRepository(db).findByIdAndPayer(POSTING, PAYER_KEY)).resolves.toBe(
      undefined,
    );
  });
});

/**
 * #1928 — THE TRANSACTION SEAM. `JobPostingsService.insertAndEmit` commits a posting row and its
 * `job_posting.created` together by handing `create` the transaction `withTransaction` opened.
 * If `create` quietly wrote on the injected db instead, the row would autocommit outside the
 * transaction and a failed emit would leave it behind, which is the #1928 defect. The real-Postgres
 * proof is in `job-posting-chat.repository.db.test.ts`; these pins run in the database-free suite.
 */
describe("JobPostingsRepository.create / withTransaction — the #1928 transaction seam", () => {
  const input = () => ({
    createdBy: PAYER,
    payerId: PAYER_KEY,
    orgLabel: "Org",
    roleTitle: "Role",
    vacancyBand: "2-5" as const,
    status: "draft" as const,
  });

  function executor(label: string) {
    const written: { table: unknown; values: unknown }[] = [];
    const db = {
      insert: vi.fn((table: unknown) => ({
        values: (values: unknown) => ({
          returning: () => {
            written.push({ table, values });
            return Promise.resolve([{ id: `${label}-row` }]);
          },
        }),
      })),
    } as unknown as Database;
    return { db, written };
  }

  it("create writes on the executor it is handed, not on the injected db", async () => {
    const injected = executor("injected");
    const tx = executor("tx");

    const created = await new JobPostingsRepository(injected.db).create(input(), tx.db);

    expect(created.id).toBe("tx-row");
    expect(tx.written).toEqual([{ table: jobPostings, values: input() }]);
    expect(injected.written).toEqual([]);
  });

  it("create with no executor writes on the injected db, as every caller outside a transaction expects", async () => {
    const injected = executor("injected");
    await new JobPostingsRepository(injected.db).create(input());
    expect(injected.written).toHaveLength(1);
  });

  it("withTransaction runs the work inside db.transaction, hands it the tx, and returns its result", async () => {
    const tx = { executor: "tx" };
    const transaction = vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx));
    const repo = new JobPostingsRepository({ transaction } as unknown as Database);

    const seen: unknown[] = [];
    const out = await repo.withTransaction(async (t) => {
      seen.push(t);
      return "done";
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(seen).toEqual([tx]);
    expect(out).toBe("done");
  });
});

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import {
  PayerApplicantStagesRepository,
  feedMembershipStatement,
  ownedPostingStagesStatement,
  type ApplicantStageKey,
} from "./payer-applicant-stages.repository";

/**
 * STRUCTURAL pins for the pipeline board's raw statements (the `payer-applicant-inbox.repository`
 * house pattern): compiled with the real `PgDialect` and asserted on TEXT and BOUND PARAMETERS.
 * Every consumer fakes this repository, so a lost ownership or membership predicate would pass
 * every other unit suite. Whether Postgres EVALUATES them that way is
 * `payer-applicant-stages.db.test.ts` (RUN_DB_TESTS=1).
 */

const dialect = new PgDialect();
const PAYER = "aaaaaaaa-0000-4000-8000-00000000000a";
const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const WORKER = "33333333-3333-4333-8333-000000000001";

function compile(statement: SQL) {
  const q = dialect.sqlToQuery(statement);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

const key = (postingKind: ApplicantStageKey["postingKind"]): ApplicantStageKey => ({
  postingKind,
  postingId: POSTING,
  workerId: WORKER,
});

describe("feedMembershipStatement — the per-posting feed's own membership, for one pair", () => {
  it.each(["agency_job", "company_posting"] as const)(
    "%s: applied, the worker bound, not pending deletion (ADR-0031 (b))",
    (kind) => {
      const { sql, params } = compile(feedMembershipStatement(key(kind)));
      expect(sql).toContain("FROM applications a INNER JOIN workers w ON w.id = a.worker_id");
      expect(sql).toContain("AND a.worker_id = $2::uuid");
      expect(sql).toContain("AND a.action = 'applied'");
      expect(sql).toContain("AND w.deletion_scheduled_at IS NULL");
      expect(sql).toMatch(/LIMIT 1$/);
      expect(params).toEqual([POSTING, WORKER]);
    },
  );

  it("agency_job matches applications.job_id AND requires a worker_profiles row (the per-job list ranks FROM it)", () => {
    const { sql } = compile(feedMembershipStatement(key("agency_job")));
    expect(sql).toContain("WHERE a.job_id = $1::uuid");
    expect(sql).not.toContain("job_posting_id");
    expect(sql).toContain(
      "AND EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.worker_id = a.worker_id)",
    );
  });

  it("company_posting matches applications.job_posting_id, with no profile requirement (listCandidates')", () => {
    const { sql } = compile(feedMembershipStatement(key("company_posting")));
    expect(sql).toContain("WHERE a.job_posting_id = $1::uuid");
    expect(sql).not.toContain("a.job_id =");
    expect(sql).not.toContain("worker_profiles");
  });
});

describe("ownedPostingStagesStatement — ownership is the SESSION payer, in both arms (XB-A)", () => {
  const { sql, params } = compile(ownedPostingStagesStatement(POSTING, PAYER));
  const at = sql.indexOf("UNION ALL");
  const agency = sql.slice(0, at);
  const company = sql.slice(at);

  it("is two arms, each its own kind literal joined to its own table", () => {
    expect(at).toBeGreaterThan(-1);
    expect(agency).toContain(
      "FROM payer_applicant_stages s INNER JOIN jobs j ON j.id = s.posting_id",
    );
    expect(agency).toContain("WHERE s.posting_kind = 'agency_job'");
    expect(company).toContain(
      "FROM payer_applicant_stages s INNER JOIN job_postings jp ON jp.id = s.posting_id",
    );
    expect(company).toContain("WHERE s.posting_kind = 'company_posting'");
  });

  it("each arm is scoped to the posting AND to the payer owning it", () => {
    expect(agency).toContain("AND s.posting_id = $1::uuid AND j.payer_id = $2::uuid");
    expect(company).toContain("AND s.posting_id = $3::uuid AND jp.payer_id = $4::uuid");
    expect(params).toEqual([POSTING, PAYER, POSTING, PAYER]);
  });

  it("projects only the kind, the worker and the stage — never a payer id", () => {
    for (const arm of [agency, company]) {
      expect(arm.slice(arm.indexOf("SELECT"), arm.indexOf(" FROM "))).toBe(
        "SELECT s.posting_kind, s.worker_id, s.stage",
      );
    }
  });
});

describe("PayerApplicantStagesRepository — the drizzle statements", () => {
  /** A Database whose every builder chain records the compiled SQL it would run. */
  function recordingDb(rows: unknown[] = []) {
    const seen: { sql: string; params: unknown[] }[] = [];
    const record = (q: { toSQL: () => { sql: string; params: unknown[] } }) => {
      const { sql, params } = q.toSQL();
      seen.push({ sql: sql.replace(/\s+/g, " "), params });
    };
    return { seen, record, rows };
  }

  it("lockStage: SELECT stage … WHERE the whole key … FOR UPDATE", async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const db = drizzle.mock() as unknown as Database;
    const r = recordingDb();
    const repo = new PayerApplicantStagesRepository(db);
    const tx = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "select") return v;
        return (...args: unknown[]) => {
          const builder = (v as (...a: unknown[]) => unknown).apply(target, args);
          return wrapTerminal(builder, r.record, []);
        };
      },
    }) as unknown as Database;
    await expect(repo.lockStage(key("company_posting"), tx)).resolves.toBeNull();
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.sql).toBe(
      'select "stage" from "payer_applicant_stages" where ("payer_applicant_stages"."posting_kind" = $1 and "payer_applicant_stages"."posting_id" = $2 and "payer_applicant_stages"."worker_id" = $3) limit $4 for update',
    );
    expect(r.seen[0]!.params).toEqual(["company_posting", POSTING, WORKER, 1]);
  });

  it("insertStage: ON CONFLICT on the primary key DO NOTHING, stamping the session payer", async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const db = drizzle.mock() as unknown as Database;
    const r = recordingDb();
    const repo = new PayerApplicantStagesRepository(db);
    const at = new Date("2026-10-07T10:00:00.000Z");
    const tx = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "insert") return v;
        return (...args: unknown[]) =>
          wrapTerminal((v as (...a: unknown[]) => unknown).apply(target, args), r.record, []);
      },
    }) as unknown as Database;
    await expect(repo.insertStage(key("agency_job"), "shortlist", PAYER, at, tx)).resolves.toBe(
      false,
    );
    expect(r.seen[0]!.sql).toContain('insert into "payer_applicant_stages"');
    expect(r.seen[0]!.sql).toContain(
      'on conflict ("posting_kind","posting_id","worker_id") do nothing returning "worker_id"',
    );
    expect(r.seen[0]!.params).toEqual(
      expect.arrayContaining(["agency_job", POSTING, WORKER, "shortlist", PAYER]),
    );
  });

  it("updateStage: SET stage, author, updated_at WHERE the whole key", async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const db = drizzle.mock() as unknown as Database;
    const r = recordingDb();
    const repo = new PayerApplicantStagesRepository(db);
    const at = new Date("2026-10-07T10:00:00.000Z");
    const tx = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "update") return v;
        return (...args: unknown[]) =>
          wrapTerminal((v as (...a: unknown[]) => unknown).apply(target, args), r.record, []);
      },
    }) as unknown as Database;
    await repo.updateStage(key("company_posting"), "passed", PAYER, at, tx);
    expect(r.seen[0]!.sql).toBe(
      'update "payer_applicant_stages" set "stage" = $1, "updated_by_payer_id" = $2, "updated_at" = $3 where ("payer_applicant_stages"."posting_kind" = $4 and "payer_applicant_stages"."posting_id" = $5 and "payer_applicant_stages"."worker_id" = $6)',
    );
  });

  it("isFeedApplicant / listOwnedPostingStages execute exactly the pinned statements", async () => {
    const executed: SQL[] = [];
    const db = {
      execute: vi.fn(async (s: SQL) => {
        executed.push(s);
        return [{ posting_kind: "company_posting", worker_id: WORKER, stage: "passed" }];
      }),
    } as unknown as Database;
    const repo = new PayerApplicantStagesRepository(db);
    await expect(repo.isFeedApplicant(key("agency_job"))).resolves.toBe(true);
    await expect(repo.listOwnedPostingStages(POSTING, PAYER)).resolves.toEqual([
      { postingKind: "company_posting", workerId: WORKER, stage: "passed" },
    ]);
    expect(dialect.sqlToQuery(executed[0]!)).toEqual(
      dialect.sqlToQuery(feedMembershipStatement(key("agency_job"))),
    );
    expect(dialect.sqlToQuery(executed[1]!)).toEqual(
      dialect.sqlToQuery(ownedPostingStagesStatement(POSTING, PAYER)),
    );
  });

  it("isFeedApplicant is false on no row; an unexpected posting kind is a defect, not data", async () => {
    const empty = new PayerApplicantStagesRepository({
      execute: async () => [],
    } as unknown as Database);
    await expect(empty.isFeedApplicant(key("company_posting"))).resolves.toBe(false);
    const odd = new PayerApplicantStagesRepository({
      execute: async () => [{ posting_kind: "job", worker_id: WORKER, stage: "new" }],
    } as unknown as Database);
    await expect(odd.listOwnedPostingStages(POSTING, PAYER)).rejects.toThrow(
      /unexpected posting kind/,
    );
  });
});

/**
 * Wrap a drizzle builder so that awaiting it RECORDS its compiled SQL and resolves `result`
 * instead of reaching a database. Every chained method returns the wrapped builder.
 */
function wrapTerminal(
  builder: unknown,
  record: (q: { toSQL: () => { sql: string; params: unknown[] } }) => void,
  result: unknown[],
): unknown {
  return new Proxy(builder as object, {
    get(target, prop, recv) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          record(target as { toSQL: () => { sql: string; params: unknown[] } });
          resolve(result);
        };
      }
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function" || prop === "toSQL") return v;
      return (...args: unknown[]) => {
        const next = (v as (...a: unknown[]) => unknown).apply(target, args);
        return next === target ? recv : wrapTerminal(next, record, result);
      };
    },
  });
}

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { ApplicationsRepository } from "../applications/applications.repository";
import { JobsRepository } from "../jobs/jobs.repository";
import { ReachRepository } from "../reach/reach.repository";
import { MatchFeedRepository } from "../match/match-feed.repository";

const dialect = new PgDialect();

/**
 * ADR-0037 Decision 1 — REGRESSION GUARD for "a suspended payer's jobs are non-discoverable".
 *
 * WHAT THIS PROTECTS. The cascade moves a suspended payer's rows out of `open` into
 * `suspended`. That only makes them invisible because EVERY discovery query constrains
 * status to `open` — so this suite pins that constraint on each of them individually. If
 * someone relaxes one (say, to `status <> 'closed'`, which reads equivalent and is not),
 * a banned payer's jobs silently return to the worker feed, and nothing else in the
 * codebase would notice. That is the exact failure this file exists to catch.
 *
 * WHY SQL-SHAPE AND NOT A DB FIXTURE. The property is about the QUERY, not about a row:
 * "this read cannot return a non-open posting, for any data". A fixture proves it for the
 * rows you thought to insert; rendering the SQL proves it for all of them. The DB-backed
 * suites are also `RUN_DB_TESTS`-gated and do not run in CI, so a fixture here would be a
 * test that never executes.
 *
 * NOT AN EXHAUSTIVE LIST BY CONSTRUCTION. Nothing forces a NEW discovery path to be
 * registered here — this pins the five that exist today (verified by enumerating every
 * reader of `jobs` and `job_postings` in apps/api). A sixth would need adding, which is
 * why the cascade's real defence is that the convention (`status = 'open'`) is the one
 * every existing reader already follows.
 */

/** A capturing mock of the Drizzle chain: records the WHERE of each SELECT. */
function makeDb() {
  const wheres: unknown[] = [];
  const executed: SQL[] = [];

  const chain = {
    where: (where: unknown) => {
      wheres.push(where);
      return {
        orderBy: () => ({ limit: async () => [] }),
        limit: async () => [],
        then: (resolve: (v: unknown[]) => unknown) => resolve([]),
      };
    },
  };

  const db = {
    select: () => ({ from: () => chain }),
    execute: async (q: SQL) => {
      executed.push(q);
      return [];
    },
  } as unknown as Database;

  return { db, wheres, executed };
}

/** Render a captured WHERE to the SQL + bound params that actually reach Postgres. */
function rendered(where: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(where as SQL);
  return { sql: q.sql, params: q.params };
}

/**
 * The assertion every discovery path must satisfy: `open` is bound as the ONLY admissible
 * status, and `suspended` appears nowhere as an accepted value.
 */
function expectOpenOnly(where: unknown): void {
  const r = rendered(where);
  expect(r.params).toContain("open");
  expect(r.params).not.toContain("suspended");
  // A negative predicate would admit `suspended` while still reading as "only live jobs".
  expect(r.sql).not.toMatch(/<>|!=|not in/i);
}

describe("ADR-0037 Decision 1 — every worker-facing discovery path excludes a suspended payer's jobs", () => {
  it("the worker feed (legacy `jobs`) serves ONLY open rows", async () => {
    const m = makeDb();
    await new ApplicationsRepository(m.db).findOpenJobs("11111111-1111-4111-8111-111111111111", 20);
    expectOpenOnly(m.wheres[0]);
  });

  it("the apply target lookup resolves ONLY open rows (a suspended job cannot be applied to)", async () => {
    // This is the application-flow half of the guarantee: discovery hiding a job is not
    // enough on its own, because a worker who already has the id (a stale feed page, a
    // deep link) would otherwise still be able to apply to it.
    const m = makeDb();
    await new ApplicationsRepository(m.db).findJobById("22222222-2222-4222-8222-222222222222");
    expectOpenOnly(m.wheres[0]);
  });

  it("the worker job-detail read resolves ONLY open rows (no 200 on a frozen job)", async () => {
    const m = makeDb();
    await new JobsRepository(m.db).findWorkerVisibleJobById("33333333-3333-4333-8333-333333333333");
    expectOpenOnly(m.wheres[0]);
  });

  it("the reach candidate set contains ONLY open rows", async () => {
    // Reach feeds the ranked worker lists a payer sees. A suspended payer's job must not
    // be scored against anybody, or the engine keeps producing matches for a banned account.
    const m = makeDb();
    await new ReachRepository(m.db).listOpenJobSignalRows();
    expectOpenOnly(m.wheres[0]);
  });

  it("the Matching-V1 feed join pins jp.status = 'open'", async () => {
    // This one is a raw SQL template rather than a builder chain, so the filter is a
    // literal in the statement rather than a bound param — assert on the rendered text.
    const m = makeDb();
    await new MatchFeedRepository(m.db).listFeed("44444444-4444-4444-8444-444444444444", 20, {});
    const q = dialect.sqlToQuery(m.executed[0]!);
    expect(q.sql.replace(/\s+/g, " ")).toContain("jp.status = 'open'");
    expect(q.sql).not.toContain("suspended");
  });
});

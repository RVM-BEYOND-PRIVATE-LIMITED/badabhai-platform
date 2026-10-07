import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import { CURRENT_PROFILE_ORDER, workerProfiles, workers, type Database } from "@badabhai/db";
import {
  ReachRepository,
  applicantSignalRowsStatement,
  applicantSignalRowsForJobsStatement,
} from "./reach.repository";

/**
 * STRUCTURAL tests for the worker-pool read (ADR-0011 D8 + ADR-0031 ruling (b)).
 *
 * The service tests mock this repository, so the ADR-0031 payer-surface freeze —
 * "a pending-deletion worker's profile row is excluded from the pool, and thus from
 * every ranked list built on it" — lives in the QUERY itself. These tests capture the
 * Drizzle fluent chain (the admin.repository.test.ts pattern) and compile the captured
 * conditions to SQL, proving the pool read is `worker_profiles INNER JOIN workers` with
 * the single MEMBERSHIP predicate `deletion_scheduled_at IS NULL` — an ELIGIBILITY
 * exclusion (same class as a hard-deleted worker), never a relevance WHERE (D8
 * sort-never-block still holds inside the eligible pool).
 */

const dialect = new PgDialect();
const compile = (cond: unknown): string => dialect.sqlToQuery(cond as SQL).sql;

type Captured = {
  selection?: Record<string, unknown>;
  distinctOn?: unknown[];
  joinTable?: unknown;
  joinOn?: unknown;
  where?: unknown;
  orderBy?: unknown[];
};

/**
 * Capturing mock of the listSignalRows chain:
 * `selectDistinctOn(cols, sel).from().innerJoin().where().orderBy()`.
 *
 * The chain gained two links with B-8b. `worker_profiles` holds one row per extraction job
 * and nothing constrains a worker to one, so the un-deduped read put a re-interviewed worker
 * into the payer pool TWICE — and `PaceService` counted him twice as supply.
 */
function makeDb(rows: unknown[]) {
  const captured: Captured = {};
  const db = {
    // The single-worker read (View B). It kept a plain `select`, but it had NO ORDER BY at
    // all before B-8b — so which of a worker's profiles a payer saw was whatever the planner
    // emitted first, and could differ between two identical requests.
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      return {
        from: () => ({
          where: (cond: unknown) => {
            captured.where = cond;
            return {
              orderBy: (...order: unknown[]) => {
                captured.orderBy = order;
                return { limit: () => Promise.resolve(rows) };
              },
              // The `jobs` reads (`findOwnedJobSignalRowById` & co.) go straight to LIMIT.
              limit: () => Promise.resolve(rows),
            };
          },
        }),
      };
    },
    selectDistinctOn: (on: unknown[], selection: Record<string, unknown>) => {
      captured.distinctOn = on;
      captured.selection = selection;
      return {
        from: () => ({
          innerJoin: (table: unknown, joinOn: unknown) => {
            captured.joinTable = table;
            captured.joinOn = joinOn;
            return {
              where: (cond: unknown) => {
                captured.where = cond;
                return {
                  // The awaited terminal link — resolves the (already-DB-filtered) rows.
                  orderBy: (...order: unknown[]) => {
                    captured.orderBy = order;
                    return Promise.resolve(rows);
                  },
                };
              },
            };
          },
        }),
      };
    },
  } as unknown as Database;
  return { db, captured };
}

function signalRow(n: number): Record<string, unknown> {
  return {
    workerId: `33333333-3333-4333-8333-${n.toString(16).padStart(12, "0")}`,
    canonicalRoleId: "vmc_operator",
    canonicalTradeId: "cnc_vmc",
    experience: { total_years: 5 },
    salaryExpectation: { amount_min: 22000, period: "monthly" },
    locationPreference: { preferred_cities: ["pune"] },
    availability: { status: "immediate" },
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
  };
}

describe("ReachRepository.listSignalRows — ADR-0031 pending-deletion pool exclusion", () => {
  it("INNER JOINs the workers table on worker_profiles.worker_id = workers.id", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    // The join target is the REAL workers table object (not a lookalike) …
    expect(captured.joinTable).toBe(workers);
    // … keyed on the profile→worker identity join.
    expect(compile(captured.joinOn)).toBe('"worker_profiles"."worker_id" = "workers"."id"');
  });

  it("filters on workers.deletion_scheduled_at IS NULL — a pending-deletion worker is NOT a pool member", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    expect(compile(captured.where)).toBe('"workers"."deletion_scheduled_at" is null');
  });

  it("the exclusion is ELIGIBILITY, not relevance (D8): a bare IS NULL — no bound signal/score values", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    // A relevance WHERE would bind values (city/pay/experience …); membership binds none.
    expect(dialect.sqlToQuery(captured.where as SQL).params).toEqual([]);
  });

  it("returns the eligible rows verbatim — count in == count out over the eligible pool", async () => {
    const eligible = [signalRow(1), signalRow(2), signalRow(3)];
    const { db } = makeDb(eligible);
    const out = await new ReachRepository(db).listSignalRows();
    expect(out).toBe(eligible); // no mapping, no client-side re-filtering
    expect(out).toHaveLength(3);
  });

  it("DISTINCT ON worker_id — one pool slot per worker, not per extraction (B-8b)", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    // The dedup key is the WORKER, so a second extraction cannot buy a second pool slot.
    expect(captured.distinctOn).toEqual([workerProfiles.workerId]);
    // Postgres requires the DISTINCT ON expression to LEAD the ORDER BY, and which row
    // survives is decided by the tail. Getting this order wrong is a runtime error, not a
    // silent mis-rank — but the tail is the part that must be the SHARED constant.
    expect(captured.orderBy?.[0]).toBe(workerProfiles.workerId);
    expect(captured.orderBy?.slice(1)).toEqual([...CURRENT_PROFILE_ORDER]);
  });

  it("picks the surviving row with the SHARED ordering, not a local copy of it", async () => {
    // Identity, not string equality: a hand-rolled `created_at DESC` that happens to compile
    // to the same SQL today is exactly how the seven readers drifted apart in the first place.
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).findSignalRowByWorkerId("w1");
    expect(captured.orderBy).toEqual([...CURRENT_PROFILE_ORDER]);
  });

  it("PROJECTION DISCIPLINE (D8): the join changes membership only — the selection stays the signal columns (never embedding/raw_profile/PII)", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    expect(Object.keys(captured.selection!).sort()).toEqual(
      [
        "workerId",
        "canonicalRoleId",
        "canonicalTradeId",
        "experience",
        "salaryExpectation",
        "locationPreference",
        "availability",
        // `skills` joined the signal projection with ADR-0033 (canonical closed-set
        // ids, not free text) BEFORE this branch landed — it is a legitimate signal
        // column, not something this join widened. The banned-column loop below is
        // what actually guards the PII boundary.
        "skills",
        "updatedAt",
      ].sort(),
    );
    // The joined workers table must not leak columns into the projection.
    // `richProfileDraft` is on this list because it carries `current_city`,
    // `education` and `certifications` — exactly the free-text detail the faceless
    // payer surface must not see. Not a live leak (SIGNAL_COLUMNS is an explicit
    // allowlist and never included it); this closes the guard's under-coverage.
    for (const banned of [
      "embedding",
      "rawProfile",
      "phoneE164",
      "phoneHash",
      "fullName",
      "deletionScheduledAt",
      "richProfileDraft",
    ]) {
      expect(captured.selection).not.toHaveProperty(banned);
    }
  });
});

describe("ReachRepository.findOwnedJobSignalRowById — payer ownership lives in the WHERE (XB-A)", () => {
  const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const PAYER = "aaaaaaaa-0000-4000-8000-00000000000a";

  it("reads jobs by id AND the session payer, binding exactly those two values", async () => {
    // The payer applicant list (#1823) branches on this read: a foreign job must miss here,
    // or another payer's weighted pool is one request away.
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).findOwnedJobSignalRowById(JOB, PAYER);
    const q = dialect.sqlToQuery(captured.where as SQL);
    expect(q.sql).toBe('("jobs"."id" = $1 and "jobs"."payer_id" = $2)');
    expect(q.params).toEqual([JOB, PAYER]);
  });

  it("payer_id is consumed in the WHERE only — never projected", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).findOwnedJobSignalRowById(JOB, PAYER);
    expect(captured.selection).not.toHaveProperty("payerId");
    expect(captured.selection).not.toHaveProperty("title");
  });

  it("no row (unknown OR another payer's job) → undefined", async () => {
    const { db } = makeDb([]);
    await expect(
      new ReachRepository(db).findOwnedJobSignalRowById(JOB, PAYER),
    ).resolves.toBeUndefined();
  });
});

describe("applicantSignalRowsStatement — #1898 the agency list is the workers who APPLIED", () => {
  // Compiled off a connection-less drizzle (the worker-transcript.repository.query pattern):
  // every consumer fakes the repository, so a lost conjunct would pass every other suite.
  const mockDb = drizzle.mock() as unknown as Database;
  const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const compiled = applicantSignalRowsStatement(mockDb, JOB).toSQL();

  it("membership is an `applied` decision on THIS job — a skip, or no decision, is never a row", () => {
    expect(compiled.sql).toContain(
      '"worker_profiles"."worker_id" in (select "worker_id" from "applications" where ("applications"."job_id" = $1 and "applications"."action" = $2))',
    );
    expect(compiled.params.slice(0, 2)).toEqual([JOB, "applied"]);
  });

  it("keeps the ADR-0031 (b) exclusion: a worker pending deletion is never listed", () => {
    expect(compiled.sql).toContain(
      'inner join "workers" on "worker_profiles"."worker_id" = "workers"."id"',
    );
    expect(compiled.sql).toContain('"workers"."deletion_scheduled_at" is null and');
  });

  it("one row per worker, the same current-profile pick as the pool (B-8b)", () => {
    expect(compiled.sql).toMatch(/^select distinct on \("worker_profiles"\."worker_id"\)/);
    expect(compiled.sql).toMatch(/order by "worker_profiles"\."worker_id", /);
  });

  it("binds only the job id and the action — no relevance predicate, no payer id", () => {
    expect(compiled.params).toEqual([JOB, "applied"]);
  });

  it("projects exactly the pool's signal columns — never embedding/raw_profile/PII", () => {
    const pool = drizzleSelectedColumns(compiled.sql);
    expect(pool).not.toMatch(/embedding|raw_profile|phone|full_name|rich_profile_draft/);
  });

  it("the repository method serves exactly this statement", async () => {
    const rows = [signalRow(1)];
    const db = {
      selectDistinctOn: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }),
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({}) }) }),
    } as unknown as Database;
    await expect(new ReachRepository(db).listApplicantSignalRowsForJob(JOB)).resolves.toBe(rows);
  });
});

/** The SELECT list of a compiled statement (everything before the first FROM). */
function drizzleSelectedColumns(sql: string): string {
  return sql.slice(0, sql.indexOf(" from "));
}

describe("ReachRepository.findOwnedJobSignalRowsByIds — the inbox's batched ownership read (XB-A)", () => {
  const JOB_1 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const JOB_2 = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
  const PAYER = "aaaaaaaa-0000-4000-8000-00000000000a";

  function capture(rows: unknown[] = []) {
    const seen: { selection?: Record<string, unknown>; where?: unknown } = {};
    const db = {
      select: (selection: Record<string, unknown>) => {
        seen.selection = selection;
        return {
          from: () => ({ where: (cond: unknown) => ((seen.where = cond), Promise.resolve(rows)) }),
        };
      },
    } as unknown as Database;
    return { repo: new ReachRepository(db), seen };
  }

  it("reads jobs by id list AND the session payer, binding exactly those values", async () => {
    const { repo, seen } = capture();
    await repo.findOwnedJobSignalRowsByIds([JOB_1, JOB_2], PAYER);
    const q = dialect.sqlToQuery(seen.where as SQL);
    expect(q.sql).toBe('("jobs"."id" in ($1, $2) and "jobs"."payer_id" = $3)');
    expect(q.params).toEqual([JOB_1, JOB_2, PAYER]);
  });

  it("projects the faceless signal columns — never payer_id or title", async () => {
    const { repo, seen } = capture();
    await repo.findOwnedJobSignalRowsByIds([JOB_1], PAYER);
    expect(seen.selection).not.toHaveProperty("payerId");
    expect(seen.selection).not.toHaveProperty("title");
    expect(Object.keys(seen.selection!).sort()).toEqual([
      "city",
      "jobId",
      "maxExperienceYears",
      "minExperienceYears",
      "neededBy",
      "payMax",
      "payMin",
      "tradeKey",
    ]);
  });

  it("an empty id list reads nothing", async () => {
    const { repo, seen } = capture();
    await expect(repo.findOwnedJobSignalRowsByIds([], PAYER)).resolves.toEqual([]);
    expect(seen.where).toBeUndefined();
  });
});

describe("applicantSignalRowsForJobsStatement — the per-job applier read, batched for the inbox", () => {
  const mockDb = drizzle.mock() as unknown as Database;
  const JOB_1 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const JOB_2 = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
  const compiled = applicantSignalRowsForJobsStatement(mockDb, [JOB_1, JOB_2]).toSQL();
  const single = applicantSignalRowsStatement(mockDb, JOB_1).toSQL();

  it("membership per job is the per-job statement's: an `applied` decision on that job", () => {
    expect(compiled.sql).toContain('"applications"."job_id" in ($1, $2)');
    expect(compiled.sql).toContain('"applications"."action" = $3');
    expect(compiled.params.slice(0, 3)).toEqual([JOB_1, JOB_2, "applied"]);
  });

  it("keeps the ADR-0031 (b) exclusion and reads FROM the profile row like the per-job read", () => {
    expect(compiled.sql).toContain(
      'inner join "worker_profiles" on "worker_profiles"."worker_id" = "applications"."worker_id"',
    );
    expect(compiled.sql).toContain(
      'inner join "workers" on "workers"."id" = "applications"."worker_id"',
    );
    expect(compiled.sql).toContain('"workers"."deletion_scheduled_at" is null');
  });

  it("one row per (job, worker), picked by the SAME current-profile order as the per-job read", () => {
    expect(compiled.sql).toMatch(
      /^select distinct on \("applications"\."job_id", "worker_profiles"\."worker_id"\)/,
    );
    // The tail after the dedup keys is the per-job statement's tail, verbatim.
    const tail = (sql: string, lead: string) => sql.slice(sql.indexOf(lead) + lead.length);
    expect(
      tail(compiled.sql, 'order by "applications"."job_id", "worker_profiles"."worker_id"'),
    ).toBe(tail(single.sql, 'order by "worker_profiles"."worker_id"'));
  });

  it("projects the job id plus EXACTLY the per-job read's signal columns — never PII", () => {
    const columns = (sql: string) =>
      drizzleSelectedColumns(sql).replace(/^select distinct on \([^)]*\) /, "");
    const selected = columns(compiled.sql);
    expect(selected.startsWith('"applications"."job_id", ')).toBe(true);
    expect(selected.replace('"applications"."job_id", ', "")).toBe(columns(single.sql));
    expect(selected).not.toMatch(
      /embedding|raw_profile|phone|full_name|rich_profile_draft|payer_id/,
    );
  });

  it("the repository method splits the job id off each row and reads nothing for no jobs", async () => {
    const rows = [{ appliedJobId: JOB_2, ...signalRow(1) }];
    let called = 0;
    const db = {
      selectDistinctOn: () => {
        called += 1;
        return {
          from: () => ({
            innerJoin: () => ({
              innerJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }),
            }),
          }),
        };
      },
    } as unknown as Database;
    const repo = new ReachRepository(db);
    await expect(repo.listApplicantSignalRowsForJobs([JOB_2])).resolves.toEqual([
      { jobId: JOB_2, row: signalRow(1) },
    ]);
    await expect(repo.listApplicantSignalRowsForJobs([])).resolves.toEqual([]);
    expect(called).toBe(1);
  });
});

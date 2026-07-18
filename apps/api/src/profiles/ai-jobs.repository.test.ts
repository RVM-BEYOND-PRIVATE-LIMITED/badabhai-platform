import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { aiJobs, workerProfiles, type Database } from "@badabhai/db";
import { AiJobsRepository } from "./ai-jobs.repository";

/**
 * STRUCTURAL tests for the issue #420 dedupe lookup. The service tests mock this
 * repository, so every guarantee that lives in the QUERY is unfalsifiable from
 * there — a fake can restate the intended semantics and pass while the real SQL
 * is wrong. These capture the Drizzle fluent chain and compile the condition with
 * PgDialect (the notifications/reach/pin.repository.test.ts pattern), so no
 * Postgres is required.
 *
 * The guarantees that MUST live in the SQL:
 *   1. job_type = 'profile_extraction'  — never dedupe against a transcription
 *      job that happens to carry the same session_id.
 *   2. session_id AND worker_id both bound — another worker's job must never
 *      deduplicate (and thus permanently deny) the owner's extraction.
 *   3. the status/age disjunction — completed always eligible; queued/running
 *      only while fresh; `failed` never.
 *   4. newest-first ordering — `asc` here would return the OLDEST job forever.
 *
 * SCOPE: this proves the predicate's SHAPE and its BOUND PARAMS, not executed
 * Postgres semantics. That is the strongest offline proof available, and it is
 * the one that catches the real regression: a dropped or loosened leg.
 */

const dialect = new PgDialect();
const compile = (cond: unknown): { sql: string; params: unknown[] } => {
  const q = dialect.sqlToQuery(cond as SQL);
  return { sql: q.sql, params: q.params };
};

type Captured = {
  selection?: Record<string, unknown>;
  from?: unknown;
  joinTable?: unknown;
  joinOn?: unknown;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
};

/** Capturing mock of select().from().leftJoin().where().orderBy().limit(). */
function makeDb(rows: unknown[] = []) {
  const captured: Captured = {};
  const db = {
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      return {
        from: (table: unknown) => {
          captured.from = table;
          return {
            leftJoin: (table2: unknown, on: unknown) => {
              captured.joinTable = table2;
              captured.joinOn = on;
              return {
                where: (cond: unknown) => {
                  captured.where = cond;
                  return {
                    orderBy: (...order: unknown[]) => {
                      captured.orderBy = order;
                      return {
                        limit: (n: number) => {
                          captured.limit = n;
                          return Promise.resolve(rows);
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, captured };
}

const SESSION = "44444444-4444-4444-8444-444444444444";
const WORKER = "11111111-1111-4111-8111-111111111111";
const SINCE = new Date("2026-07-18T10:00:00.000Z");

async function run(rows: unknown[] = []) {
  const { db, captured } = makeDb(rows);
  const result = await new AiJobsRepository(db).findExtractionDedupeCandidate({
    sessionId: SESSION,
    workerId: WORKER,
    inFlightSince: SINCE,
  });
  return { captured, result };
}

describe("AiJobsRepository.findExtractionDedupeCandidate — the predicate (#420)", () => {
  it("reads ai_jobs and LEFT JOINs the profile the job produced", async () => {
    const { captured } = await run();
    expect(captured.from).toBe(aiJobs);
    expect(captured.joinTable).toBe(workerProfiles);
    // Joined on worker_profiles.ai_job_id = ai_jobs.id (the TD14 unique tie).
    const on = compile(captured.joinOn);
    expect(on.sql).toContain('"ai_job_id"');
    expect(on.sql).toContain('"id"');
  });

  it("constrains job_type to profile_extraction — a transcription job on the same session must never match", async () => {
    const { captured } = await run();
    const { sql, params } = compile(captured.where);
    expect(sql).toContain('"job_type"');
    expect(params).toContain("profile_extraction");
  });

  it("binds BOTH session_id and worker_id out of input_ref (no cross-worker dedupe)", async () => {
    const { captured } = await run();
    const { sql, params } = compile(captured.where);
    expect(sql).toContain("->>'session_id'");
    expect(sql).toContain("->>'worker_id'");
    expect(params).toContain(SESSION);
    expect(params).toContain(WORKER);
  });

  it("bounds queued/running by age and leaves completed unbounded", async () => {
    const { captured } = await run();
    const { sql, params } = compile(captured.where);
    expect(params).toContain("queued");
    expect(params).toContain("running");
    expect(params).toContain("completed");
    // The age floor is bound (Drizzle serializes the Date to its ISO string), and
    // applied with a STRICT `>` against created_at — `>=` must not satisfy this.
    expect(params).toContain(SINCE.toISOString());
    expect(sql).toMatch(/"created_at" > \$\d+/);
    expect(sql).not.toMatch(/"created_at" >=/);
  });

  /**
   * The SHAPE of the disjunction, not merely the presence of its parts.
   *
   * Asserting only "SINCE is bound somewhere" and "there is an ` or `" is
   * satisfied by a REAL regression: hoisting `gt(createdAt, inFlightSince)` out of
   * the in-flight branch into the top-level `and()`. That compiles, and the whole
   * suite (161 files / 1787 tests) stays green — while age-bounding the COMPLETED
   * leg too. A worker who finishes an interview and reopens profile-preview 11
   * minutes later then matches nothing, so every mount burns a new ai_job, a new
   * worker_profiles row and a real AI call: #420 re-opens for anyone slower than
   * EXTRACTION_IN_FLIGHT_WINDOW_MS.
   *
   * So: the age bound must live INSIDE the in-flight branch, and the completed
   * leg must be a bare status equality.
   */
  it("scopes the age bound to the IN-FLIGHT branch only — completed must stay unbounded", async () => {
    const { captured } = await run();
    const { sql } = compile(captured.where);

    // ((status in (...) and created_at > $n) or status = $m)
    expect(sql).toMatch(
      /\(\s*\(\s*"ai_jobs"\."status" in \([^)]*\)\s+and\s+"ai_jobs"\."created_at" > \$\d+\s*\)\s+or\s+"ai_jobs"\."status" = \$\d+\s*\)/i,
    );

    // …and the bound appears EXACTLY once, so it cannot ALSO sit at top level
    // (hoisting it leaves the two legs intact and would slip past the regex).
    expect(sql.match(/"created_at" >/g)).toHaveLength(1);
  });

  it("never matches a FAILED job — 'failed' is not bound anywhere in the predicate", async () => {
    const { captured } = await run();
    const { params } = compile(captured.where);
    expect(params).not.toContain("failed");
  });

  it("orders NEWEST first (an `asc` regression would pin the oldest job forever)", async () => {
    const { captured } = await run();
    expect(captured.orderBy).toHaveLength(1);
    expect(compile(captured.orderBy![0]).sql).toMatch(/"created_at" desc/i);
    expect(captured.limit).toBe(1);
  });

  it("selects the profile-content columns the usability check needs, and no others", async () => {
    const { captured } = await run();
    expect(Object.keys(captured.selection!).sort()).toEqual([
      "availability",
      "canonicalRoleId",
      "canonicalTradeId",
      "experience",
      "id",
      "locationPreference",
      "machines",
      "profileId",
      "richProfileDraft",
      "salaryExpectation",
      "skills",
      "status",
    ]);
  });
});

describe("AiJobsRepository.findExtractionDedupeCandidate — row mapping", () => {
  it("returns undefined when nothing matches", async () => {
    const { result } = await run([]);
    expect(result).toBeUndefined();
  });

  it("maps a job with NO joined profile to profile: null (LEFT JOIN miss)", async () => {
    const { result } = await run([
      {
        id: "job-1",
        status: "completed",
        profileId: null,
        canonicalTradeId: null,
        canonicalRoleId: null,
        skills: null,
        machines: null,
        experience: null,
        salaryExpectation: null,
        locationPreference: null,
        availability: null,
        richProfileDraft: null,
      },
    ]);
    expect(result).toEqual({ id: "job-1", status: "completed", profile: null });
  });

  it("maps the joined profile columns through when a profile row exists", async () => {
    const { result } = await run([
      {
        id: "job-1",
        status: "completed",
        profileId: "profile-1",
        canonicalTradeId: "cnc",
        canonicalRoleId: null,
        skills: ["vmc_operation"],
        machines: [],
        experience: { total_years: 4 },
        salaryExpectation: {},
        locationPreference: {},
        availability: { status: "unknown" },
        richProfileDraft: { skill_labels: ["cnc operator"] },
      },
    ]);
    expect(result?.id).toBe("job-1");
    expect(result?.profile).toEqual({
      canonicalTradeId: "cnc",
      canonicalRoleId: null,
      skills: ["vmc_operation"],
      machines: [],
      experience: { total_years: 4 },
      salaryExpectation: {},
      locationPreference: {},
      availability: { status: "unknown" },
      richProfileDraft: { skill_labels: ["cnc operator"] },
    });
  });
});

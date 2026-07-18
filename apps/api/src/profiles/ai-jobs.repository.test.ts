import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { Column, Param, StringChunk, is, type SQL } from "drizzle-orm";
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
 * SCOPE: this first suite proves the predicate's SHAPE and its BOUND PARAMS, not
 * executed Postgres semantics. The second suite ("the predicate, EVALUATED")
 * closes that gap by interpreting the Drizzle AST as a boolean function over
 * candidate rows — still no Postgres, but rendering-independent and behavioural,
 * so a regression that merely reformats the SQL cannot hide in it.
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
   * the in-flight branch into the top-level `and()`, which age-bounds the
   * COMPLETED leg too. A worker who finishes an interview and reopens
   * profile-preview 11 minutes later then matches nothing, so every mount burns a
   * new ai_job, a new worker_profiles row and a real AI call: #420 re-opens for
   * anyone slower than EXTRACTION_IN_FLIGHT_WINDOW_MS.
   *
   * So: the age bound must live INSIDE the in-flight branch, and the completed
   * leg must be a bare status equality.
   *
   * NOTE (PR #438 review): these two assertions are STRING matches over generated
   * SQL, and the hoist survives both when written without spaces
   * (`sql`${aiJobs.createdAt}>${args.inFlightSince}``) — Drizzle then renders
   * `"created_at">$n`, so the count below still sees exactly one match. They are
   * kept as a cheap shape check, but the guarantee itself is enforced
   * behaviourally in the EVALUATED suite below, which is what actually kills that
   * mutation.
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

/* -------------------------------------------------------------------------
 * BEHAVIOURAL evaluation of the predicate (PR #438 review, MEDIUM 2).
 *
 * Everything above matches STRINGS over generated SQL, and that is weaker than
 * it looks. The scoping regression it is meant to catch — hoisting the age bound
 * out of the in-flight branch into the top-level and() — can be reintroduced in
 * a form that passes every assertion above:
 *
 *     sql`${aiJobs.createdAt}>${args.inFlightSince}`   // note: no spaces
 *
 * Drizzle renders that as `"ai_jobs"."created_at">$n`, so `/"created_at" >/g`
 * still counts exactly 1 and the shape regex still matches the untouched
 * disjunction. The whole suite stays green while the COMPLETED leg is age-bounded
 * again and #420 re-opens for any worker slower than the in-flight window.
 *
 * The service tests cannot catch it either: their fake re-implements the
 * predicate, hard-coding the intended semantics, so it is true by construction.
 *
 * So the predicate is evaluated here as a BOOLEAN FUNCTION over candidate rows,
 * by interpreting the Drizzle AST directly. That is rendering-independent —
 * whitespace, operator spelling and leg order cannot affect it — and it tests the
 * guarantee itself ("does a completed job of ANY age still match?") rather than
 * the shape of the SQL that is supposed to imply it. No database is involved.
 * ---------------------------------------------------------------------------*/

/** The `ai_jobs` fields the dedupe predicate reads. */
interface CandidateRow {
  jobType: string;
  status: string;
  createdAt: Date;
  inputRef: Record<string, string>;
}

const COLUMN_READERS: Record<string, (row: CandidateRow) => unknown> = {
  job_type: (r) => r.jobType,
  status: (r) => r.status,
  created_at: (r) => r.createdAt,
  input_ref: (r) => r.inputRef,
};

/** Comparable scalar: Dates by epoch, everything else as-is. */
const scalar = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

type Item = { op: string } | { operand: unknown };
const isOp = (i: Item): i is { op: string } => "op" in i;

/** Direct chunks of a SQL node, with StringChunks flattened to operator text. */
function itemsOf(node: unknown): Item[] {
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) throw new Error("not a SQL node");
  const items: Item[] = [];
  for (const chunk of chunks) {
    if (is(chunk, StringChunk)) {
      for (const piece of chunk.value) {
        const op = piece.trim();
        if (op !== "") items.push({ op });
      }
    } else if (Array.isArray(chunk)) {
      // `inArray` passes its value list through as one raw array chunk.
      for (const element of chunk) items.push({ operand: element });
    } else {
      items.push({ operand: chunk });
    }
  }
  return items;
}

/** Unwrap the `(`…`)` Drizzle wraps every and()/or() group in. */
function stripParens(items: Item[]): Item[] {
  const first = items[0];
  const last = items[items.length - 1];
  if (
    items.length >= 2 &&
    first &&
    last &&
    isOp(first) &&
    first.op === "(" &&
    isOp(last) &&
    last.op === ")"
  ) {
    return items.slice(1, -1);
  }
  return items;
}

/** Split a chunk list on a top-level boolean operator into its operand groups. */
function splitOn(items: Item[], op: "and" | "or"): unknown[] {
  return items
    .filter((i) => !isOp(i) || i.op !== op)
    .map((i) => (i as { operand: unknown }).operand);
}

/**
 * Evaluate a Drizzle condition against a row.
 *
 * Handles exactly the operator vocabulary this predicate uses — `and`, `or`,
 * `=`, `>`, `in`, and the `->>'key'` jsonb extraction. Anything else throws
 * loudly rather than silently evaluating to a passing value, so a future leg
 * built from an unsupported operator fails the test instead of being ignored.
 */
function evaluateCondition(node: unknown, row: CandidateRow): boolean {
  const items = stripParens(itemsOf(node));
  const ops = items.filter(isOp).map((i) => i.op);

  // A bare wrapper: `(<sql>)` with nothing else. Drizzle nests these freely.
  if (ops.length === 0 && items.length === 1) {
    return evaluateCondition((items[0] as { operand: unknown }).operand, row);
  }
  if (ops.includes("and") && ops.includes("or")) {
    throw new Error("mixed and/or at one level — Drizzle should have grouped these");
  }
  if (ops.includes("and")) {
    return splitOn(items, "and").every((child) => evaluateCondition(child, row));
  }
  if (ops.includes("or")) {
    return splitOn(items, "or").some((child) => evaluateCondition(child, row));
  }

  // Leaf comparison: <column> <operator> <value…>
  const operands = items.filter((i): i is { operand: unknown } => !isOp(i)).map((i) => i.operand);
  const column = operands.find((o) => is(o, Column));
  if (!column) throw new Error(`no column in leaf: ${ops.join(" ")}`);

  const reader = COLUMN_READERS[column.name];
  if (!reader) throw new Error(`unhandled column: ${column.name}`);

  const values = operands
    .filter((o) => !is(o, Column))
    .map((o) => (is(o, Param) ? (o as Param).value : o));

  let left: unknown = reader(row);
  let operator = ops.join(" ");

  // `input_ref->>'session_id' = $n`: descend into the jsonb, then compare.
  const jsonb = /^->>'([^']+)'\s*(.*)$/.exec(operator);
  if (jsonb) {
    const [, key, rest] = jsonb;
    left = (left as Record<string, unknown>)[key!];
    operator = rest!.trim();
  }

  switch (operator) {
    case "=":
      return scalar(left) === scalar(values[0]);
    case ">":
      return (scalar(left) as number) > (scalar(values[0]) as number);
    case "in":
      return values.some((v) => scalar(v) === scalar(left));
    default:
      throw new Error(`unhandled operator: ${operator}`);
  }
}

describe("AiJobsRepository.findExtractionDedupeCandidate — the predicate, EVALUATED", () => {
  const FRESH = new Date(SINCE.getTime() + 60_000); // inside the in-flight window
  const STALE = new Date(SINCE.getTime() - 60_000); // outside it

  const row = (patch: Partial<CandidateRow> = {}): CandidateRow => ({
    jobType: "profile_extraction",
    status: "completed",
    createdAt: FRESH,
    inputRef: { session_id: SESSION, worker_id: WORKER },
    ...patch,
  });

  const matches = async (patch: Partial<CandidateRow> = {}): Promise<boolean> => {
    const { captured } = await run();
    return evaluateCondition(captured.where, row(patch));
  };

  it("sanity: the evaluator agrees the baseline row matches", async () => {
    expect(await matches()).toBe(true);
  });

  /**
   * THE #420 GUARANTEE, stated behaviourally. A worker who finishes an interview
   * and reopens profile-preview long after the in-flight window must still match
   * their completed job — otherwise every mount burns a fresh ai_job, a fresh
   * worker_profiles row and a real AI call.
   *
   * This is the assertion the no-space hoisting mutation cannot survive.
   */
  it("a COMPLETED job matches at ANY age — the age bound must not reach this leg", async () => {
    expect(await matches({ status: "completed", createdAt: STALE })).toBe(true);
    expect(
      await matches({ status: "completed", createdAt: new Date(SINCE.getTime() - 86_400_000) }),
    ).toBe(true);
  });

  it("queued/running match only while FRESH — a zombie job must never be returned", async () => {
    expect(await matches({ status: "queued", createdAt: FRESH })).toBe(true);
    expect(await matches({ status: "running", createdAt: FRESH })).toBe(true);
    expect(await matches({ status: "queued", createdAt: STALE })).toBe(false);
    expect(await matches({ status: "running", createdAt: STALE })).toBe(false);
  });

  it("the age bound is STRICT — a job created exactly at the floor is not in flight", async () => {
    expect(await matches({ status: "queued", createdAt: SINCE })).toBe(false);
  });

  it("a FAILED job never matches, at any age — extraction stays retryable", async () => {
    expect(await matches({ status: "failed", createdAt: FRESH })).toBe(false);
    expect(await matches({ status: "failed", createdAt: STALE })).toBe(false);
  });

  it("another WORKER's job never matches — no cross-worker denial", async () => {
    expect(await matches({ inputRef: { session_id: SESSION, worker_id: "someone-else" } })).toBe(
      false,
    );
  });

  it("another SESSION's job never matches", async () => {
    expect(await matches({ inputRef: { session_id: "other-session", worker_id: WORKER } })).toBe(
      false,
    );
  });

  it("a transcription job on the same session never matches", async () => {
    expect(await matches({ jobType: "voice_transcription" })).toBe(false);
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

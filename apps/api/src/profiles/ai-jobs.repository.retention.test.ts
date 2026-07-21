import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { Column, Param, StringChunk, asc, is, sql, type SQL } from "drizzle-orm";
import { aiJobs, workerProfiles, type Database } from "@badabhai/db";
import { AiJobsRepository, retentionPruneWhere } from "./ai-jobs.repository";

/**
 * STRUCTURAL + BEHAVIOURAL tests for the PERF-3 retention-prune predicate and the
 * two queries built on it (the ai-jobs.repository.test.ts pattern: compile the
 * Drizzle chain with PgDialect, then ALSO interpret the AST as a boolean function
 * over candidate rows — no Postgres required, rendering-independent).
 *
 * The processor tests mock this repository, so every guarantee that lives in the
 * QUERY is unfalsifiable from there. The guarantees that MUST live in the SQL:
 *   1. status ∈ {completed, failed} ONLY — queued/running rows are NEVER pruned,
 *      at any age (a zombie row is the #420 in-flight guard's problem).
 *   2. STRICT `updated_at < cutoff` — age counts from the terminal transition
 *      (never created_at), and a row exactly at the cutoff survives.
 *   3. THE LANDMINE: a terminal row referenced by `worker_profiles.ai_job_id`
 *      (the TD14 tie, no FK) is NEVER pruned. The #420 dedupe LEFT JOINs through
 *      that ref to find the prior COMPLETED extraction; pruning one would blind
 *      it and re-open real AI spend on every profile-preview mount
 *      (#427/#430/#438/#467).
 *   4. The armed DELETE uses the SAME predicate the dry-run summary counts
 *      (shared `retentionPruneWhere`), re-applied at delete time on top of the
 *      bounded id batch (the claimDueDeletion atomic re-check posture).
 */

const dialect = new PgDialect();
const compile = (cond: unknown): { sql: string; params: unknown[] } => {
  const q = dialect.sqlToQuery(cond as SQL);
  return { sql: q.sql, params: q.params };
};

const CUTOFF = new Date("2026-04-22T00:00:00.000Z"); // now - 90d in the sweep

describe("retentionPruneWhere — the predicate, compiled (PERF-3)", () => {
  it("binds ONLY the terminal statuses — queued/running never appear", () => {
    const { params } = compile(retentionPruneWhere(CUTOFF));
    expect(params).toContain("completed");
    expect(params).toContain("failed");
    expect(params).not.toContain("queued");
    expect(params).not.toContain("running");
  });

  it("ages on updated_at with a STRICT `<` — and never touches created_at", () => {
    const { sql, params } = compile(retentionPruneWhere(CUTOFF));
    expect(sql).toMatch(/"updated_at" < \$\d+/);
    expect(sql).not.toMatch(/"updated_at" >?=/);
    // The window must count from the TERMINAL transition, not row creation.
    expect(sql).not.toContain('"created_at"');
    expect(params).toContain(CUTOFF.toISOString());
  });

  it("excludes rows referenced by worker_profiles.ai_job_id — the exact TD14 tie, as NOT EXISTS", () => {
    const { sql } = compile(retentionPruneWhere(CUTOFF));
    expect(sql).toContain(
      'not exists (select 1 from "worker_profiles" where "worker_profiles"."ai_job_id" = "ai_jobs"."id")',
    );
  });

  it("is a conjunction: terminal AND aged AND unreferenced (no OR leg can widen it)", () => {
    const { sql } = compile(retentionPruneWhere(CUTOFF));
    expect(sql).not.toMatch(/ or /i);
  });
});

/* -------------------------------------------------------------------------
 * The predicate, EVALUATED (the #438-review pattern). String matches over
 * generated SQL are weaker than they look, so the AST is interpreted as a
 * boolean function over candidate rows. The exists-subquery is evaluated
 * against a `referencedByWorkerProfile` flag — but ONLY after identity-checking
 * that the subquery is the exact worker_profiles.ai_job_id = ai_jobs.id tie
 * (any other exists throws rather than silently passing).
 * ---------------------------------------------------------------------------*/

/** The `ai_jobs` facts the prune predicate may read. */
interface CandidateRow {
  status: string;
  updatedAt: Date;
  /** Does any worker_profiles.ai_job_id point at this row? (the TD14 tie) */
  referencedByWorkerProfile: boolean;
}

const COLUMN_READERS: Record<string, (row: CandidateRow) => unknown> = {
  status: (r) => r.status,
  updated_at: (r) => r.updatedAt,
  // Deliberately NO created_at reader: a predicate aging on created_at throws.
};

const scalar = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

type Item = { op: string } | { operand: unknown };
const isOp = (i: Item): i is { op: string } => "op" in i;

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
      for (const element of chunk) items.push({ operand: element });
    } else {
      items.push({ operand: chunk });
    }
  }
  return items;
}

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

function splitOn(items: Item[], op: "and" | "or"): unknown[] {
  return items
    .filter((i) => !isOp(i) || i.op !== op)
    .map((i) => (i as { operand: unknown }).operand);
}

function evaluateCondition(node: unknown, row: CandidateRow): boolean {
  const items = stripParens(itemsOf(node));
  const ops = items.filter(isOp).map((i) => i.op);

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

  // `not <inner>` — negate the wrapped node.
  if (ops.length === 1 && ops[0] === "not" && items.length === 2) {
    const inner = items.find((i) => !isOp(i)) as { operand: unknown };
    return !evaluateCondition(inner.operand, row);
  }

  // The correlated reference probe. Refuse to interpret ANY other exists: the
  // operands must be exactly the workerProfiles table, its ai_job_id column and
  // ai_jobs.id (object identity — the imported schema objects themselves).
  if (ops[0]?.startsWith("exists")) {
    const operands = items.filter((i): i is { operand: unknown } => !isOp(i)).map((i) => i.operand);
    if (
      !operands.includes(workerProfiles) ||
      !operands.includes(workerProfiles.aiJobId) ||
      !operands.includes(aiJobs.id)
    ) {
      throw new Error("unrecognized exists-subquery — not the worker_profiles.ai_job_id tie");
    }
    return row.referencedByWorkerProfile;
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

  const left = reader(row);
  switch (ops.join(" ")) {
    case "=":
      return scalar(left) === scalar(values[0]);
    case "<":
      return (scalar(left) as number) < (scalar(values[0]) as number);
    case "in":
      return values.some((v) => scalar(v) === scalar(left));
    default:
      throw new Error(`unhandled operator: ${ops.join(" ")}`);
  }
}

describe("retentionPruneWhere — the predicate, EVALUATED", () => {
  const OLD = new Date(CUTOFF.getTime() - 86_400_000); // 1 day past the window
  const ANCIENT = new Date(CUTOFF.getTime() - 365 * 86_400_000);
  const YOUNG = new Date(CUTOFF.getTime() + 86_400_000); // still inside the window

  const row = (patch: Partial<CandidateRow> = {}): CandidateRow => ({
    status: "completed",
    updatedAt: OLD,
    referencedByWorkerProfile: false,
    ...patch,
  });

  const matches = (patch: Partial<CandidateRow> = {}): boolean =>
    evaluateCondition(retentionPruneWhere(CUTOFF), row(patch));

  it("prunes terminal-and-old: completed and failed rows past the window match", () => {
    expect(matches({ status: "completed" })).toBe(true);
    expect(matches({ status: "failed" })).toBe(true);
  });

  /**
   * THE LANDMINE, stated behaviourally. A completed extraction row that a
   * worker_profiles row references (TD14) feeds the #420 dedupe — pruning it
   * would make a worker re-opening profile-preview after 90 days fire a fresh
   * REAL-AI extraction on every mount until the new job completes. It must
   * survive retention at ANY age.
   */
  it("NEVER prunes a referenced terminal row, at any age — the #420 dedupe stays sighted", () => {
    expect(matches({ referencedByWorkerProfile: true })).toBe(false);
    expect(matches({ referencedByWorkerProfile: true, updatedAt: ANCIENT })).toBe(false);
    // Conservative on purpose: even a referenced FAILED row is kept (worker_profiles
    // only ever references completed extractions today, but the guard is generic).
    expect(matches({ status: "failed", referencedByWorkerProfile: true })).toBe(false);
  });

  it("NEVER prunes queued/running rows, regardless of age (a zombie is #420's problem, not retention's)", () => {
    expect(matches({ status: "queued", updatedAt: OLD })).toBe(false);
    expect(matches({ status: "running", updatedAt: OLD })).toBe(false);
    expect(matches({ status: "queued", updatedAt: ANCIENT })).toBe(false);
    expect(matches({ status: "running", updatedAt: ANCIENT })).toBe(false);
  });

  it("leaves younger-than-window rows untouched", () => {
    expect(matches({ updatedAt: YOUNG })).toBe(false);
    expect(matches({ status: "failed", updatedAt: YOUNG })).toBe(false);
  });

  it("the cutoff is STRICT — a row updated exactly at the boundary survives", () => {
    expect(matches({ updatedAt: CUTOFF })).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * The two queries built on the predicate: chain capture (the makeDb pattern).
 * ---------------------------------------------------------------------------*/

interface CapturedQuery {
  selection?: Record<string, unknown>;
  from?: unknown;
  where?: unknown;
  groupBy?: unknown[];
  orderBy?: unknown[];
  limit?: number;
}

/** Capturing db double for summarizeRetentionPrune (two selects: grouped + count). */
function makeSummarizeDb(groupRows: unknown[], countRows: Array<{ n: number }>) {
  const calls: CapturedQuery[] = [];
  const db = {
    select(selection: Record<string, unknown>) {
      const call: CapturedQuery = { selection };
      calls.push(call);
      const chain = {
        from(table: unknown) {
          call.from = table;
          return chain;
        },
        where(cond: unknown) {
          call.where = cond;
          return chain;
        },
        groupBy(...groups: unknown[]) {
          call.groupBy = groups;
          return Promise.resolve(groupRows);
        },
        // The count query is awaited straight off `.where(...)`.
        then(onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) {
          return Promise.resolve(countRows).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  } as unknown as Database;
  return { db, calls };
}

const ARGS = {
  cutoff: CUTOFF,
  cutoff2x: new Date("2026-01-22T00:00:00.000Z"),
  cutoff4x: new Date("2025-07-26T00:00:00.000Z"),
};

describe("AiJobsRepository.summarizeRetentionPrune — the dry-run report", () => {
  it("counts CANDIDATES with the exact shared prune predicate (report ≡ what armed mode would delete)", async () => {
    const { db, calls } = makeSummarizeDb([], [{ n: 0 }]);
    await new AiJobsRepository(db).summarizeRetentionPrune(ARGS);
    expect(calls[0]!.from).toBe(aiJobs);
    expect(compile(calls[0]!.where)).toEqual(compile(retentionPruneWhere(CUTOFF)));
    // Grouped per job type; the FILTER buckets carry the age distribution.
    expect(calls[0]!.groupBy).toEqual([aiJobs.jobType]);
    const selection = compile(calls[0]!.selection!["upTo2x"]);
    expect(selection.sql).toContain("filter");
    // Raw-template params carry the Date itself (no column encoder) — unlike the
    // lt() leaf, whose timestamptz encoder serializes to the ISO string.
    expect(selection.params).toContain(ARGS.cutoff2x);
  });

  it("counts SKIPPED-REFERENCED rows with the INVERTED reference probe (terminal + aged + EXISTS)", async () => {
    const { db, calls } = makeSummarizeDb([], [{ n: 0 }]);
    await new AiJobsRepository(db).summarizeRetentionPrune(ARGS);
    const { sql, params } = compile(calls[1]!.where);
    expect(sql).toContain(
      'exists (select 1 from "worker_profiles" where "worker_profiles"."ai_job_id" = "ai_jobs"."id")',
    );
    expect(sql).not.toContain("not exists"); // referenced rows, not unreferenced ones
    expect(params).toContain("completed");
    expect(params).toContain("failed");
    expect(sql).toMatch(/"updated_at" < \$\d+/);
  });

  it("aggregates counts across job types (candidates, byType, age buckets, skipped)", async () => {
    const { db } = makeSummarizeDb(
      [
        { jobType: "profile_extraction", total: 5, upTo2x: 2, upTo4x: 2 },
        { jobType: "transcription", total: 3, upTo2x: 3, upTo4x: 0 },
      ],
      [{ n: 4 }],
    );
    const summary = await new AiJobsRepository(db).summarizeRetentionPrune(ARGS);
    expect(summary).toEqual({
      candidates: 8,
      skippedReferenced: 4,
      byType: { profile_extraction: 5, transcription: 3 },
      ageDistribution: { upTo2x: 5, upTo4x: 2, over4x: 1 },
    });
  });

  it("an empty table summarizes to zeroes (a no-op sweep is a valid, loggable outcome)", async () => {
    const { db } = makeSummarizeDb([], [{ n: 0 }]);
    const summary = await new AiJobsRepository(db).summarizeRetentionPrune(ARGS);
    expect(summary).toEqual({
      candidates: 0,
      skippedReferenced: 0,
      byType: {},
      ageDistribution: { upTo2x: 0, upTo4x: 0, over4x: 0 },
    });
  });
});

/** Capturing db double for pruneRetentionBatch (bounded select + guarded delete). */
function makePruneDb(deletedRows: Array<{ id: string }>) {
  const select: CapturedQuery = {};
  const del: { from?: unknown; where?: unknown; returned?: boolean } = {};
  const db = {
    select(selection: Record<string, unknown>) {
      select.selection = selection;
      const chain = {
        from(table: unknown) {
          select.from = table;
          return chain;
        },
        where(cond: unknown) {
          select.where = cond;
          return chain;
        },
        orderBy(...order: unknown[]) {
          select.orderBy = order;
          return chain;
        },
        limit(n: number) {
          select.limit = n;
          // Stand-in for the un-executed subquery builder: a real SQL node (a
          // SQLWrapper, so inArray embeds it) that renders identifiably in the
          // compiled DELETE.
          return batchMarker as never;
        },
      };
      return chain;
    },
    delete(table: unknown) {
      del.from = table;
      return {
        where(cond: unknown) {
          del.where = cond;
          return {
            returning(sel: unknown) {
              del.returned = sel !== undefined;
              return Promise.resolve(deletedRows);
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, select, del };
}

// A real SQL node so drizzle's inArray embeds it verbatim in the compiled DELETE.
const batchMarker = sql`__CANDIDATE_BATCH__`;

describe("AiJobsRepository.pruneRetentionBatch — the armed delete", () => {
  it("selects candidates with the SAME shared predicate, oldest-first, bounded by the batch limit", async () => {
    const { db, select } = makePruneDb([]);
    await new AiJobsRepository(db).pruneRetentionBatch(CUTOFF, 1000);
    expect(select.from).toBe(aiJobs);
    expect(compile(select.where)).toEqual(compile(retentionPruneWhere(CUTOFF)));
    expect(select.limit).toBe(1000);
    expect(compile(select.orderBy![0]).sql).toEqual(compile(asc(aiJobs.updatedAt)).sql);
  });

  it("the DELETE re-applies the FULL prune predicate on top of the id batch (atomic re-check)", async () => {
    const { db, del } = makePruneDb([]);
    await new AiJobsRepository(db).pruneRetentionBatch(CUTOFF, 1000);
    expect(del.from).toBe(aiJobs);
    const { sql, params } = compile(del.where);
    // The bounded batch is embedded…
    expect(sql).toContain('"ai_jobs"."id" in __CANDIDATE_BATCH__');
    // …AND the whole predicate is re-evaluated at delete time, so a row that
    // gained a worker_profiles reference between SELECT and DELETE survives.
    expect(sql).toContain(
      'not exists (select 1 from "worker_profiles" where "worker_profiles"."ai_job_id" = "ai_jobs"."id")',
    );
    expect(params).toContain("completed");
    expect(params).toContain("failed");
    expect(params).toContain(CUTOFF.toISOString());
  });

  it("returns the count of rows ACTUALLY deleted (via RETURNING), not the batch size", async () => {
    const { db, del } = makePruneDb([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const n = await new AiJobsRepository(db).pruneRetentionBatch(CUTOFF, 1000);
    expect(n).toBe(3);
    expect(del.returned).toBe(true);
  });
});

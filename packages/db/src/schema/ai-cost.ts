/**
 * AI SPEND, MATERIALIZED — the three running totals the cost dashboard reads (migration 0077).
 *
 * WHY A TABLE AND NOT `SUM()` OVER THE SPINE. `ai.cost_recorded` is the ledger and stays the
 * source of truth; these rows are its materialization, exactly as `payer_credits` is a
 * materialization of `credit_ledger` (packages/db/src/schema/payer.ts). Everything else was
 * measured and rejected:
 *   - `SUM(ai_jobs.cost_inr) WHERE input_ref->>'worker_id' = ?` — the only expression index on
 *     `ai_jobs` (`ai_jobs_extraction_session_idx`) is PARTIAL on `job_type='profile_extraction'`
 *     AND leads on `session_id`, so a worker-keyed aggregate is a sequential scan of a table
 *     with no retention policy. The measured index note in ops.ts (~1M rows) is about that same
 *     table: cost there is a function of the job-type mix, not a property anyone controls.
 *   - `SUM(events.payload->>'estimated_cost_inr')` — worse: `events` is the largest table in the
 *     system, indexed on name/subject/correlation and never on a payload expression, and a
 *     jsonb-text cast per row cannot use any of them.
 * Both get slower every day the platform works. An UPSERT of one row per call does not.
 *
 * THREE TABLES, ONE QUESTION EACH — and the split is forced by what has an owner:
 *   worker_ai_cost_totals    "what did this worker cost?"          (worker-attributed spend)
 *   session_ai_cost_totals   "what did this profiling session cost?" (per-interview spend)
 *   platform_ai_cost_totals  "what have we spent, by provider?"    (EVERY call, attributed or not)
 * The platform table cannot be derived from the worker table, and that is the whole reason it
 * exists: `skill_embedding` on a job-posting write and `job_posting_chat_turn` are PAYER-side
 * calls with no worker at all. A platform figure summed from worker rows would silently omit
 * them and read as a complete total — the exact "silence means zero" failure the cost spine was
 * built to end.
 *
 * PROVIDER IS STORED, NEVER DERIVED. `provider` is already a first-class field on
 * `AICallMetadata` and on `AiCostRecordedPayload`; the alternative — deriving Sarvam / Gemini /
 * Claude from a model name at read time — means a model→provider map maintained in the read
 * layer that silently misclassifies every model added after it was written. It is the PK of the
 * platform table because "split by provider" is the question that table answers.
 *
 * NO PER-PROVIDER BREAKDOWN ON THE WORKER/SESSION ROWS, deliberately. The product ask is a
 * per-provider split PLATFORM-WIDE; per-worker it is speculative. Adding it later is
 * `ALTER TABLE ... ADD COLUMN cost_by_provider jsonb DEFAULT '{}'`, which is O(1) metadata-only
 * on Postgres 11+ and backfillable from the event spine — so building it now buys nothing and
 * costs a read-modify-write of a jsonb blob inside the hot cost transaction.
 *
 * DPDP / DSAR ERASURE IS THE CASCADE, WITH ZERO CODE. `WorkersRepository.hardDelete` enumerates
 * no table names, so `ON DELETE CASCADE` on `worker_id` *is* the coverage (the pattern
 * pack-answer.ts documents). `session_ai_cost_totals` is doubly covered: its `chat_session_id`
 * cascades from `chat_sessions`, which itself cascades from `workers`.
 *
 * PRIVACY (§2): ids, ₹ amounts and integer counts ONLY. `worker_id` / `chat_session_id` are the
 * same opaque internal UUIDs `ai_jobs.input_ref` and every event's `subject_id` already carry.
 * There is no name, phone, model output, prompt or transcript here, and none may be added.
 *
 * BACKFILL: these tables start EMPTY and accrue only from the deploy that lands them forward.
 * Historical spend already on the event spine is NOT counted, and no backfill migration ships
 * here on purpose — a backfill is a data change over `events`, needs an owner's sign-off, and
 * is a separate, re-runnable script. Until one runs, every figure here means "since 0077".
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  index,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";

import { workers } from "./worker";
import { chatSessions } from "./chat";

/**
 * The money column, shared by all three tables.
 *
 * `numeric(16, 6)`, NOT `double precision`. `ai_jobs.cost_inr` is a float because it stores ONE
 * call's estimate; this is a RUNNING SUM of millions of them, and float addition is neither
 * associative nor exact — a total accumulated by repeated `+=` drifts from the sum of the same
 * rows in a different order, which is indefensible on a page labelled "total spend". Six decimal
 * places because a single embed call costs a small fraction of a paisa; sixteen digits of
 * precision leaves ten for whole rupees (₹9,999,999,999), which the platform will not reach.
 *
 * READ AS A STRING by default (drizzle's `numeric` mode) — deliberately. The read layer that
 * formats rupees decides where to lose precision; this layer does not decide it for them.
 */
const costInr = (name: string) => numeric(name, { precision: 16, scale: 6 });

/**
 * `worker_ai_cost_totals` — one row per worker who has ever cost anything.
 *
 * WRITTEN ONLY BY `AiCostRecorder.record()`, inside the same transaction as the
 * `ai.cost_recorded` insert, and ONLY when that insert actually wrote a row (the event's
 * `idempotency_key` is `ai.cost_recorded:<ai_call_id>`, so a redelivered call inserts no event
 * and moves no total). That binding — accrue iff the ledger row is new — is what makes a
 * retried queue job idempotent here, and it is the same rule `AdminActionsRepository.grantCredits`
 * uses to bind a credit ledger row to a balance move.
 */
export const workerAiCostTotals = pgTable(
  "worker_ai_cost_totals",
  {
    // PK *is* the worker: one row per worker, upserted on conflict. No surrogate id — there is
    // nothing to reference this row by, and a surrogate would allow two rows per worker.
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    totalCostInr: costInr("total_cost_inr").notNull().default("0"),
    // Calls, and how many of them were REAL. A ₹0 total with 40 calls and 0 real calls is a
    // mock environment; ₹0 with 0 calls is a worker nothing has been spent on; ₹0 with 40 real
    // calls is a pricing bug. One integer buys the difference between three very different
    // stories that a bare total tells identically.
    callCount: integer("call_count").notNull().default(0),
    realCallCount: integer("real_call_count").notNull().default(0),
    firstRecordedAt: timestamp("first_recorded_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "Most expensive workers" — the admin list read. Descending because that is the only
    // direction the question is ever asked in.
    index("worker_ai_cost_totals_cost_idx").on(t.totalCostInr.desc()),
    // Spend never decreases: `record()` only ever adds a non-negative `estimated_cost_inr`
    // (the payload's own `z.number().nonnegative()`). A negative total here would mean a
    // subtraction path exists, and none may.
    check("worker_ai_cost_totals_nonneg_chk", sql`${t.totalCostInr} >= 0`),
    check(
      "worker_ai_cost_totals_counts_chk",
      sql`${t.callCount} >= 0 AND ${t.realCallCount} >= 0 AND ${t.realCallCount} <= ${t.callCount}`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0077

/**
 * `session_ai_cost_totals` — one row per profiling session that has cost anything.
 *
 * THE UNIT THE PRODUCT ACTUALLY BUYS. A worker can be interviewed more than once (a re-interview
 * under a new question pack, an abandoned session resumed as a new one), so "cost per worker"
 * and "cost per profile we produced" are different numbers, and the second is the one that
 * divides into revenue.
 *
 * `worker_id` IS DENORMALIZED HERE on purpose: it makes "this worker's sessions, each with its
 * cost" a single indexed read rather than a join through `chat_sessions`, and it gives the row a
 * SECOND cascade path to erasure so the DPDP guarantee does not rest on one FK.
 */
export const sessionAiCostTotals = pgTable(
  "session_ai_cost_totals",
  {
    chatSessionId: uuid("chat_session_id")
      .primaryKey()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    totalCostInr: costInr("total_cost_inr").notNull().default("0"),
    callCount: integer("call_count").notNull().default(0),
    realCallCount: integer("real_call_count").notNull().default(0),
    firstRecordedAt: timestamp("first_recorded_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "This worker's sessions, newest cost first" + the FK-referencing column Postgres does
    // not index for you (without it a worker delete seq-scans this table to cascade).
    index("session_ai_cost_totals_worker_idx").on(t.workerId),
    check("session_ai_cost_totals_nonneg_chk", sql`${t.totalCostInr} >= 0`),
    check(
      "session_ai_cost_totals_counts_chk",
      sql`${t.callCount} >= 0 AND ${t.realCallCount} >= 0 AND ${t.realCallCount} <= ${t.callCount}`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0077

/**
 * `platform_ai_cost_totals` — one row per provider, covering EVERY recorded call.
 *
 * "Total LLM cost till now" is `SELECT sum(total_cost_inr) FROM platform_ai_cost_totals` over a
 * handful of rows, and the provider split is the rows themselves. No singleton row, because a
 * singleton would need a second structure to answer the split, and no aggregate over
 * `worker_ai_cost_totals`, because that one cannot see payer-side spend (see the header).
 *
 * KEYED ON (provider, task_type), not provider alone. It is ~4 providers x ~9 task types = a
 * few dozen rows either way, and the pair answers "what does profiling cost us platform-wide,
 * and on whose bill" without a second table. `task_type` mirrors the event's closed
 * `aiTaskType` enum and `provider` mirrors `AICallMetadata.provider` (both fall back to the
 * literal `'unknown'`, exactly as the event payload does, so an unlabelled call is still
 * counted rather than dropped).
 *
 * KNOWN TRADE-OFF — ROW CONTENTION. Every recorded call updates exactly one row here, so
 * concurrent calls of the same (provider, task_type) serialize on it. That is acceptable by
 * construction: the write rate is bounded by PROVIDER LATENCY (each row update follows a call
 * that took hundreds of milliseconds), and the lock is held for microseconds inside an already
 * short transaction. If it ever shows up in p95, the escape hatch is to stop maintaining this
 * table inline and roll it up from the event spine on a schedule — the worker/session tables
 * and the spine are unaffected by that change.
 *
 * NO WORKER LINKAGE AT ALL, so nothing to cascade and nothing to erase: this table survives a
 * DSAR deletion intact, which is correct — the money was spent whether or not the subject
 * remains.
 */
export const platformAiCostTotals = pgTable(
  "platform_ai_cost_totals",
  {
    provider: text("provider").notNull(),
    taskType: text("task_type").notNull(),
    totalCostInr: costInr("total_cost_inr").notNull().default("0"),
    callCount: integer("call_count").notNull().default(0),
    realCallCount: integer("real_call_count").notNull().default(0),
    firstRecordedAt: timestamp("first_recorded_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite PK: the upsert's conflict target, and the only key this table has.
    primaryKey({ columns: [t.provider, t.taskType], name: "platform_ai_cost_totals_pkey" }),
    check("platform_ai_cost_totals_nonneg_chk", sql`${t.totalCostInr} >= 0`),
    check(
      "platform_ai_cost_totals_counts_chk",
      sql`${t.callCount} >= 0 AND ${t.realCallCount} >= 0 AND ${t.realCallCount} <= ${t.callCount}`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0077

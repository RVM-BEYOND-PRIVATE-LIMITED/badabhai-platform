/**
 * AI CALL TRACES — the prompt and the completion, for the one question the cost row cannot answer.
 *
 * WHAT THIS EXISTS FOR. `ai_jobs` and the `ai.cost_recorded` event already answer "what did this
 * call cost, on which model, for which worker". Neither answers "what did we actually ASK, and
 * what came back" — the question every AI regression starts with, and the reason the Langfuse
 * tracer was wired in the first place. Langfuse is dormant behind an unclosed processor sign-off,
 * so today that text exists nowhere at all: an interview that goes wrong is unreviewable after the
 * fact. This table is the first-party, in-VPC answer.
 *
 * ── PRIVACY CLASS: THE HIGHEST ON THE SPINE, AND THE MOST NARROWLY GUARDED ──
 *
 * `prompt_enc` / `response_enc` hold the FINAL prompt and completion of one AI call. Those strings
 * pass the pseudonymization boundary before they are minted (`apps/ai-service/app/pseudonymize.py`)
 * and are pseudonymized by contract — but a pseudonymizer is a best-effort transform over free
 * text, and R32 measured the name gazetteer DEAD at 348 leaks in 487 probes. So this schema does
 * NOT assume the text is clean. It assumes the opposite and contains it:
 *
 *   1. CIPHERTEXT AT REST, ENFORCED BY THE DATABASE. Both columns carry the `@badabhai/db`
 *      AES-256-GCM token (`v1.<iv>.<tag>.<ct>` / `v2.<kid>.<iv>.<tag>.<ct>`), and the
 *      `..._enc_token_chk` CHECKs below make that a 23514 rather than a code-review question:
 *      a row holding prose is REFUSED by Postgres. A full database read — a leaked dump, a stolen
 *      replica, a PostgREST misconfiguration — yields no readable prompt, because the key lives
 *      only in backend config and never in the database (ADR-0004).
 *
 *      ⚠ WHAT THAT CHECK DOES **NOT** SAY, stated plainly so no reader infers more (the
 *      `screen_context` lesson): it enforces "this column holds an AES-GCM token, not prose". It
 *      cannot and does not enforce that the PLAINTEXT INSIDE was pseudonymized. That property is
 *      the producer's, held at the ai-service boundary, and it is the reason the read path below
 *      is gated the way it is rather than opened to everyone who can read a cost figure.
 *
 *   2. THE READ IS A DIFFERENT PRIVILEGE FROM THE LIST. Decrypting is gated on the new
 *      `read_ai_traces` capability (super_admin only), behind a default-OFF
 *      `ADMIN_AI_TRACE_READ_ENABLED` flag that returns a NEUTRAL 404 when unset, and every
 *      decrypt writes an `admin.ai_trace_viewed` audit row FAIL-CLOSED — no audit row, no text.
 *      The PII-free scalars (`task_type`, `model_name`, `success`, the two `*_chars` lengths)
 *      carry no such gate, so "which calls failed, how big were they" stays answerable to ops
 *      without anyone reading a worker's words.
 *
 *   3. THE TEXT NEVER RIDES THE SPINE. No event, log line or analytics row carries these columns
 *      — the same rule `worker_feedback.message` follows, and for the same §2 reason. What ships
 *      is `prompt_chars` / `response_chars`: a LENGTH, which is what a size question actually
 *      needs, mirroring `feedback.submitted`'s `message_length` and `job.search_performed`'s
 *      treatment of the search term.
 *
 * ── DPDP / DSAR ERASURE IS TOTAL BY CONSTRUCTION, NOT BY DILIGENCE ──
 *
 * `worker_id` is **NOT NULL** with `ON DELETE cascade`. That single choice is the erasure design.
 * `WorkersRepository.hardDelete` is one `DELETE FROM workers` enumerating no child table, so the
 * cascade IS the coverage — and because the column cannot be null, there is no such thing as a
 * trace this repository will fail to erase. A nullable `worker_id` would have been the easier
 * schema and would have quietly created a class of prompt text that survives a worker's deletion
 * request forever, which is precisely the failure DPDP §12 names.
 *
 * The cost of that strictness is paid at the WRITER, deliberately: a call with no worker behind it
 * (payer-side `skill_embedding`, `job_posting_chat_turn`) is DROPPED rather than stored
 * unattributed. Losing an unattributable trace is a telemetry gap; keeping one is an
 * un-erasable record of somebody's words. `AiTraceRecorder` makes that choice explicit and counts
 * the drops.
 *
 * `session_id` cascades for the same reason. `ai_job_id` is `set null` instead — `ai_jobs` is a
 * faceless operational table with no worker FK and its own lifecycle, so an ai_job disappearing
 * must not take a worker-owned trace with it; the row keeps its worker linkage and the erasure
 * path above still governs it.
 *
 * ── RETENTION: INDEFINITE, BY OWNER RULING ──
 *
 * There is no `expires_at` and no TTL sweeper. The owner ruled traces are kept indefinitely so an
 * old regression stays diagnosable; erasure is therefore ENTIRELY the DSAR cascade above, which is
 * why that cascade had to be total rather than best-effort. Volume is the accepted trade: this
 * table grows with every AI call and will outgrow `ai_jobs`. If that ruling is ever revisited, the
 * change is additive (a nullable `expires_at` + a sweeper), not a rewrite.
 */
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, integer, timestamp, index, check } from "drizzle-orm/pg-core";

import { workers } from "./worker";
import { chatSessions } from "./chat";
import { aiJobs } from "./ops";

/**
 * The shape of a `@badabhai/db` AES-256-GCM token, as SQL sees it.
 *
 * Mirrors `encryptPii` (`v1.<iv_b64>.<tag_b64>.<ct_b64>`) and `encryptPiiWithKeyring`
 * (`v2.<kid>.<iv_b64>.<tag_b64>.<ct_b64>`, kid per `PII_KID_PATTERN`). SQL cannot import, so
 * `ai-trace-schema.test.ts` mints real tokens with both functions and asserts the database accepts
 * them — and that a plaintext sentence is refused with 23514. That test is the link keeping this
 * literal honest, the same device `worker_feedback_message_len_chk` uses for its bound.
 *
 * DELIBERATELY a SHAPE check, not a length or charset bound. A length says nothing (prose has a
 * length); a shape says "four or five dot-delimited base64 fields behind a version tag", which no
 * sentence a human or a model produces can satisfy.
 */
const ENC_TOKEN_SQL_PATTERN =
  "^(v1\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+" +
  "|v2\\.[A-Za-z0-9_-]{1,32}\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+)$";

// ---------------------------------------------------------------------------
// ai_call_traces — one row per completed AI call, append-only, never updated
// ---------------------------------------------------------------------------
export const aiCallTraces = pgTable(
  "ai_call_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The `ai_call_id` the cost event already carries — the join key back to
     * `ai.cost_recorded` and to `ai_jobs.output_ref`. NOT a foreign key: `events` is
     * append-only and jsonb-keyed, so there is nothing to reference. Unique so a retried
     * recorder cannot double-write the same call.
     */
    aiCallId: uuid("ai_call_id").notNull().unique(),
    /**
     * NOT NULL + cascade IS the DSAR design — see the header. A call with no worker behind it
     * is dropped by the recorder, never stored unattributed.
     */
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** The profiling session this call belongs to, when it is a chat turn. Cascades with the worker. */
    sessionId: uuid("session_id").references(() => chatSessions.id, { onDelete: "cascade" }),
    /**
     * The async job row, when there is one. `set null`, NOT cascade: `ai_jobs` is faceless and
     * has its own lifecycle; it must never be able to erase a worker-owned trace.
     */
    aiJobId: uuid("ai_job_id").references(() => aiJobs.id, { onDelete: "set null" }),
    /** The request-scoped correlation id (opaque, PII-free) — ties a trace to its API request log. */
    correlationId: text("correlation_id"),
    /**
     * `aiTaskType`'s value, as text.
     *
     * NO IN-LIST CHECK, and that is the 0081 reasoning applied verbatim: the ai-service gaining a
     * task type is routine, an IN-list would make that widening a MIGRATION that must precede the
     * deploy, and getting that order wrong turns every trace of the new surface into a 23514. The
     * closed set is enforced where a second emitter would actually fail closed — `aiTaskType` in
     * the event schema — not in a fourth copy that cannot import.
     */
    taskType: text("task_type").notNull(),
    /** The model that served the call, e.g. `gemini-2.5-flash`. PII-free by construction. */
    modelName: text("model_name"),
    /** Which prompt template, and which version of it, produced the request. */
    promptName: text("prompt_name"),
    promptVersion: text("prompt_version"),
    /** AES-256-GCM ciphertext token. NEVER plaintext — the CHECK below refuses it. */
    promptEnc: text("prompt_enc"),
    responseEnc: text("response_enc"),
    /**
     * PLAINTEXT LENGTHS, stored so the ungated list can answer "how big was this call" without
     * anyone decrypting anything. A count of characters, never the characters.
     */
    promptChars: integer("prompt_chars"),
    responseChars: integer("response_chars"),
    /** Whether a provider was actually called, or the mock adapter answered (mirrors `ai_jobs.real_call`). */
    realCall: boolean("real_call").notNull().default(false),
    /** Whether the call returned a usable result. */
    success: boolean("success").notNull(),
    /**
     * A CLOSED-SET error code on failure — never a provider message, which is untrusted text that
     * routinely echoes the request back and would smuggle the prompt into an unencrypted column.
     */
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The FK-referencing columns Postgres does not index for you.
    index("ai_call_traces_worker_id_idx").on(t.workerId),
    index("ai_call_traces_session_id_idx").on(t.sessionId),
    index("ai_call_traces_ai_job_id_idx").on(t.aiJobId),
    // The admin list's keyset sort. `.nullsFirst()` is LOAD-BEARING on both keyset indexes —
    // drizzle's bare `desc()` emits no NULLS clause and Postgres reads that as DESC NULLS FIRST,
    // which an index built DESC NULLS LAST does not satisfy; the planner then keeps the index for
    // the filter and adds a Sort, which is the entire cost these indexes exist to remove. Both
    // columns are NOT NULL, so this changes no result — only the plan. (0067 / 0080 lesson.)
    index("ai_call_traces_admin_keyset_idx").on(
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // The per-worker drill-down on the journey page — LEADING on worker_id, because the
    // unfiltered list above cannot serve it and one index cannot serve both.
    index("ai_call_traces_worker_keyset_idx").on(
      t.workerId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // ── The privacy invariant, enforced by the database itself (see the header) ──
    check(
      "ai_call_traces_prompt_enc_token_chk",
      sql`${t.promptEnc} IS NULL OR ${t.promptEnc} ~ ${sql.raw(`'${ENC_TOKEN_SQL_PATTERN}'`)}`,
    ),
    check(
      "ai_call_traces_response_enc_token_chk",
      sql`${t.responseEnc} IS NULL OR ${t.responseEnc} ~ ${sql.raw(`'${ENC_TOKEN_SQL_PATTERN}'`)}`,
    ),
    // Bounds on the operational scalars. Lengths only — these are producer-controlled, so the
    // job here is keeping a column from being repurposed as a second free-text channel around
    // the encrypted ones, not validating untrusted input.
    check("ai_call_traces_task_type_len_chk", sql`char_length(${t.taskType}) BETWEEN 1 AND 64`),
    check(
      "ai_call_traces_model_name_len_chk",
      sql`${t.modelName} IS NULL OR char_length(${t.modelName}) BETWEEN 1 AND 128`,
    ),
    check(
      "ai_call_traces_prompt_name_len_chk",
      sql`${t.promptName} IS NULL OR char_length(${t.promptName}) BETWEEN 1 AND 128`,
    ),
    check(
      "ai_call_traces_prompt_version_len_chk",
      sql`${t.promptVersion} IS NULL OR char_length(${t.promptVersion}) BETWEEN 1 AND 64`,
    ),
    check(
      "ai_call_traces_correlation_id_len_chk",
      sql`${t.correlationId} IS NULL OR char_length(${t.correlationId}) BETWEEN 1 AND 128`,
    ),
    // 64 chars is a CODE, not a message. A provider error string does not fit, which is the point.
    check(
      "ai_call_traces_error_code_len_chk",
      sql`${t.errorCode} IS NULL OR char_length(${t.errorCode}) BETWEEN 1 AND 64`,
    ),
    check(
      "ai_call_traces_prompt_chars_chk",
      sql`${t.promptChars} IS NULL OR ${t.promptChars} >= 0`,
    ),
    check(
      "ai_call_traces_response_chars_chk",
      sql`${t.responseChars} IS NULL OR ${t.responseChars} >= 0`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0083

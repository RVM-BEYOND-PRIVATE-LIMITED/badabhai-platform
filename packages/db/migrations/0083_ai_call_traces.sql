-- ===========================================================================
-- 0083 — AI CALL TRACES: one new table (Phase 3)
--
-- FULLY ADDITIVE. One NEW table, empty on arrival. Nothing is dropped, nothing is renamed, no
-- shipped column changes meaning, and no existing read or write touches it.
--
-- ORDER: APPLY BEFORE DEPLOY — but this one FAILS SOFT, unlike 0080. `AiTraceRecorder` names
-- `ai_call_traces` on the AI-call path, and the write is deliberately OUTSIDE the caller's
-- transaction inside its own catch: a trace is telemetry, and losing one must never cost a
-- worker their interview turn or a payer their posting. Against an unmigrated database every AI
-- call still succeeds and every trace is silently dropped (counted, and logged once per process).
-- The admin read is the loud half: GET /admin/ai-traces 500s on first page load. Recorded in
-- `schema-contract.ts`, so `pnpm --filter @badabhai/db db:audit:schema-contract` answers "is this
-- database ready?" rather than anyone taking it on report — the 0078 lesson.
--
-- TIMING (the DDL, as distinct from deploy ORDER). THREE ADD CONSTRAINT ... FOREIGN KEY, each
-- taking SHARE ROW EXCLUSIVE on its parent — `workers`, `chat_sessions` and `ai_jobs`. All three
-- are hot, and `ai_jobs` is written by every queue worker. Validation is instant (the new table is
-- empty), but each lock request queues behind any in-flight transaction on that table, and every
-- writer arriving meanwhile queues behind IT. Per the 0073/0077/0080 precedent this is timing
-- guidance, not a blocker: run under `SET lock_timeout = '3s';` and retry on 55P03
-- (lock_not_available). Three parents means three chances to queue — off-peak is worth more here
-- than it was for 0080.
--
-- BACKFILL: NONE, AND NONE IS POSSIBLE. Prompt and completion text has never been persisted
-- anywhere in this system — the Langfuse tracer that would have held it is dormant behind an
-- unclosed processor sign-off. This table starts the record; every AI call before it is
-- permanently unreviewable.
--
-- ENCRYPTED AT REST, ENFORCED BY THE DATABASE. `prompt_enc` / `response_enc` hold the
-- `@badabhai/db` AES-256-GCM token (`v1.<iv>.<tag>.<ct>` / `v2.<kid>.<iv>.<tag>.<ct>`), and the
-- two `..._enc_token_chk` CHECKs above make that a 23514 rather than a code-review question: a row
-- holding prose is REFUSED. The key lives only in backend config, never in the database (ADR-0004),
-- so a full dump yields no readable prompt.
--   ⚠ WHAT THAT CHECK DOES NOT SAY: it enforces "this column holds an AES-GCM token, not prose".
--   It cannot enforce that the PLAINTEXT INSIDE was pseudonymized — that property is the
--   ai-service boundary's, and R32 measured its name gazetteer dead. Which is exactly why the read
--   path is capability-gated, flag-gated and audited fail-closed rather than open to anyone who can
--   already read a cost figure. Do not let this file's own comment be quoted as more than it is.
--
-- DSAR ERASURE IS TOTAL BY CONSTRUCTION. `worker_id` is NOT NULL with ON DELETE cascade.
-- `WorkersRepository.hardDelete` is one `DELETE FROM workers` enumerating no child table, so the
-- cascade IS the coverage — and because the column cannot be null there is no class of trace this
-- repository can fail to erase. A nullable worker_id would have been the easier schema and would
-- have quietly created prompt text that survives a deletion request forever. The cost is paid at
-- the writer instead: an unattributable call (payer-side `skill_embedding`, `job_posting_chat_turn`)
-- is DROPPED, never stored faceless. `session_id` cascades for the same reason; `ai_job_id` is
-- `set null` because `ai_jobs` is faceless with its own lifecycle and must never be able to erase a
-- worker-owned row.
--
-- RETENTION: INDEFINITE, BY OWNER RULING — no `expires_at`, no sweeper. Erasure is ENTIRELY the
-- cascade above, which is why that cascade had to be total. Volume is the accepted trade: this
-- table grows with every AI call and will outgrow `ai_jobs`. Revisiting the ruling is additive
-- (a nullable `expires_at` + a sweeper), not a rewrite.
--
-- RLS. The FORCE + REVOKE tail below is HAND-APPENDED, mirroring 0073/0076/0077/0080: the
-- generator models ENABLE but neither FORCE nor the grant revocations, and without FORCE the table
-- OWNER bypasses every policy — which is the only connection the backend uses, so ENABLE alone
-- would be decorative. This table earns it more than any before it: `worker_feedback.message` is
-- one worker's paragraph, whereas this is EVERY prompt and EVERY completion for EVERY worker. The
-- ciphertext CHECK is the first lock and this is the second; neither is sufficient alone.
--
-- ROLLBACK. Drop the table — no other table has an FK to it, no view or function selects from it,
-- and its three FKs, five indexes and eleven CHECKs go with it. Safe with the app live in the
-- direction 0080 was not: the recorder already catches, so dropping this only makes traces stop
-- being written. GET /admin/ai-traces 500s, so revert the app first anyway.
--   DROP TABLE IF EXISTS "ai_call_traces";
-- Lossy by definition: the rows ARE the record, and nothing reconstructs a prompt from the event
-- spine, which carries only LENGTHS by design. Export first if the table is not empty.
-- Also listed in LOCKED_TABLES in tests/e2e/rls-spine.e2e.test.ts, which asserts RLS + FORCE +
-- no-grants per NAME — remove that entry in the same change.
--
-- MIGRATION SLOT. 0083. 0082 was taken by `0082_rls_lock_seven_tables` (#1037) while this branch
-- was in flight; this file was GENERATED at 0083, never renamed (the 0071 rule — a drizzle
-- snapshot chains to its predecessor by prevId, so a renamed file would chain off the wrong one
-- and the next generate would diff against a schema missing a migration entirely).
-- ===========================================================================
CREATE TABLE "ai_call_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ai_call_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"session_id" uuid,
	"ai_job_id" uuid,
	"correlation_id" text,
	"task_type" text NOT NULL,
	"model_name" text,
	"prompt_name" text,
	"prompt_version" text,
	"prompt_enc" text,
	"response_enc" text,
	"prompt_chars" integer,
	"response_chars" integer,
	"real_call" boolean DEFAULT false NOT NULL,
	"success" boolean NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_call_traces_ai_call_id_unique" UNIQUE("ai_call_id"),
	CONSTRAINT "ai_call_traces_prompt_enc_token_chk" CHECK ("ai_call_traces"."prompt_enc" IS NULL OR "ai_call_traces"."prompt_enc" ~ '^(v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+|v2\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+)$'),
	CONSTRAINT "ai_call_traces_response_enc_token_chk" CHECK ("ai_call_traces"."response_enc" IS NULL OR "ai_call_traces"."response_enc" ~ '^(v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+|v2\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+)$'),
	CONSTRAINT "ai_call_traces_task_type_len_chk" CHECK (char_length("ai_call_traces"."task_type") BETWEEN 1 AND 64),
	CONSTRAINT "ai_call_traces_model_name_len_chk" CHECK ("ai_call_traces"."model_name" IS NULL OR char_length("ai_call_traces"."model_name") BETWEEN 1 AND 128),
	CONSTRAINT "ai_call_traces_prompt_name_len_chk" CHECK ("ai_call_traces"."prompt_name" IS NULL OR char_length("ai_call_traces"."prompt_name") BETWEEN 1 AND 128),
	CONSTRAINT "ai_call_traces_prompt_version_len_chk" CHECK ("ai_call_traces"."prompt_version" IS NULL OR char_length("ai_call_traces"."prompt_version") BETWEEN 1 AND 64),
	CONSTRAINT "ai_call_traces_correlation_id_len_chk" CHECK ("ai_call_traces"."correlation_id" IS NULL OR char_length("ai_call_traces"."correlation_id") BETWEEN 1 AND 128),
	CONSTRAINT "ai_call_traces_error_code_len_chk" CHECK ("ai_call_traces"."error_code" IS NULL OR char_length("ai_call_traces"."error_code") BETWEEN 1 AND 64),
	CONSTRAINT "ai_call_traces_prompt_chars_chk" CHECK ("ai_call_traces"."prompt_chars" IS NULL OR "ai_call_traces"."prompt_chars" >= 0),
	CONSTRAINT "ai_call_traces_response_chars_chk" CHECK ("ai_call_traces"."response_chars" IS NULL OR "ai_call_traces"."response_chars" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_call_traces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_call_traces" ADD CONSTRAINT "ai_call_traces_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_traces" ADD CONSTRAINT "ai_call_traces_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_traces" ADD CONSTRAINT "ai_call_traces_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_call_traces_worker_id_idx" ON "ai_call_traces" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "ai_call_traces_session_id_idx" ON "ai_call_traces" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ai_call_traces_ai_job_id_idx" ON "ai_call_traces" USING btree ("ai_job_id");--> statement-breakpoint
CREATE INDEX "ai_call_traces_admin_keyset_idx" ON "ai_call_traces" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ai_call_traces_worker_keyset_idx" ON "ai_call_traces" USING btree ("worker_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
-- HAND-APPENDED (see the RLS note in this file's header). FORCE + REVOKE ALL, so the lock is a
-- real denial on every PostgREST Data-API role rather than an ENABLE the owner walks through.
ALTER TABLE "ai_call_traces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_call_traces" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_call_traces" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_call_traces" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_call_traces" FROM service_role;

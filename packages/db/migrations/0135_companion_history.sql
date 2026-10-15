-- ==============================================================================
-- 0135 - companion_messages + companion_conversation_summaries: the Bada Bhai chat's history
-- ==============================================================================
--
-- #2297 (owner rulings 2026-10-15, ADR-0056). The Bada Bhai chat (the companion, ADR-0044) keeps
-- its conversation ON THE SERVER for 7 days, and its AI keeps a rolling summary of it.
--
--   companion_messages - one row per line as the app draws it: the worker's message (`worker`)
--     and Bada Bhai's reply (`bada_bhai`) with its read-aloud twin, its "never read aloud" marker,
--     chips and news tiles; plus the recap bubble served on the first open of a window.
--     `model_context` marks the lines a later model call may read (the turns the Redis memory
--     would have kept); a distress turn and a trash verdict are never among them (ADR-0055
--     F3/F4). The partial unique index on (worker_id, submission_id, role) makes a replayed
--     submission insert nothing.
--   companion_conversation_summaries - one row per worker: the rolling notes (screened by the
--     API) and `folded_through`, the watermark of the newest line they cover. `summary` is NULL
--     on a watermark-only record (ADR-0051 §8: a judged batch that produced no usable notes).
--
-- TEXT AT REST, like `chat_messages.body_text`: the worker's own words, unencrypted (ADR-0047).
-- Name and phone stay encrypted in `workers` only. ERASURE is the worker_id cascade on both
-- tables: the account-deletion hard delete removes every line and the summary.
--
-- RETENTION: `CompanionHistorySweepProcessor` (daily) deletes lines older than 7 days - a range
-- over `companion_messages_created_at_idx`, so a tick never scans the table - and every EXPIRED
-- summary (`folded_through`, the newest line it covers, has left the window). Nothing else deletes
-- rows.
--
-- ADDITIVE ONLY. Two new, empty tables; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY AFTER THE DEPLOY, AT ANY TIME. NO FLAG. Every read and write of these
-- tables tolerates `undefined_table` (42P01): until this file is applied the chat stores nothing,
-- returns no `history`, reads no companion summary and behaves exactly as before, with one warn
-- line per API process. Applying it turns the feature on for the next request. Registered as
-- `0135-companion-messages-rls` and `0135-companion-conversation-summaries-rls` in
-- `schema-contract.ts`, so `db:audit:schema-contract` reports them missing until it is applied;
-- listed in LOCKED_TABLES in the e2e RLS spine.
--
-- THE OWNER'S SEQUENCE - applies ONLY 0135 and records ONLY its ledger row. Every lower entry that
-- is unapplied on purpose (a dark feature: 0128, 0129, 0134 ...) is neither verified, applied nor
-- recorded. Run from the MAIN checkout on a clean tree at origin/main after the merge (the journal
-- must contain 0135). DATABASE_URL is never typed or printed: adopt-migrations.ts and
-- audit-schema-contract.ts load it from the repo-root .env themselves and print only its host.
--   0. Merge. The deploy is safe on its own: the tables are not read by anything that can fail.
--   1. Read-only pre-check, from packages/db:
--        npx tsx adopt-migrations.ts --only 0135_companion_history
--      Expect "[adopt] target host=<HOST>" (note <HOST>) and "✗ 0135_companion_history - <n>
--      mismatch(es)", every one MISSING: nothing is applied yet, so exit 1 is expected here.
--   2. Apply 0135 and nothing else: Supabase dashboard, production project, SQL Editor, a new
--      query holding exactly
--        BEGIN;
--        SET LOCAL lock_timeout = '3s';
--        <the full contents of packages/db/migrations/0135_companion_history.sql, unedited>
--        COMMIT;
--      and Run. "canceling statement due to lock timeout" (55P03) means nothing was applied:
--      run it again.
--   3. Read-only verify, from packages/db:
--        npx tsx adopt-migrations.ts --only 0135_companion_history
--      Expect "✓ 0135_companion_history" and "clean=1 mismatched=0".
--   4. Record ONLY 0135's ledger row, from packages/db:
--        npx tsx adopt-migrations.ts --only 0135_companion_history --apply --expect-host <HOST>
--      Expect "recorded 1 of 1 verified migration(s)".
--   5. Audit (read-only), from packages/db:  pnpm db:audit:schema-contract
--      Expect "OK 0135_companion_history rls companion_messages" and "... companion_conversation_
--      summaries"; entries of migrations kept dark on purpose still read MISSING.
-- No flag and no redeploy: the next request uses the tables. NEVER run `pnpm db:migrate` against
-- production - it would apply every unrecorded entry above the ledger watermark, dark ones too. After
-- step 4 the watermark is 0135's `when`, so `db:migrate` skips any lower entry still unrecorded:
-- apply each of those later the same way (by hand, then adopt-migrations --only <its tag>).
--
-- LOCKS. CREATE TABLE touches nothing live. Each FK takes SHARE ROW EXCLUSIVE on `workers` for its
-- (empty-table, instant) validation; that lock still queues behind any long-running transaction
-- on `workers` and blocks writers behind it - hence the lock_timeout and retry. Dropping the
-- tables (rollback) is heavier: removing an FK's referential-integrity triggers takes ACCESS
-- EXCLUSIVE on `workers`, which blocks every worker read and write while it waits, so the
-- rollback needs the same lock_timeout and retry.
--
-- ROLLBACK. No code change is needed first: the API treats a missing table as "no history". In
-- ONE transaction, retrying on 55P03:
--        BEGIN;
--        SET LOCAL lock_timeout = '3s';
--        DROP TABLE "companion_messages";
--        DROP TABLE "companion_conversation_summaries";
--        DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792067253821;
--        COMMIT;
--      (1792067253821 is this entry's journal `when`; without deleting its row, drizzle's
--      watermark never re-applies 0135.)
-- Dropping them loses every stored conversation and summary; the chat then opens with the recap
-- after every reopen, exactly as before this migration.
-- ==============================================================================
CREATE TABLE "companion_conversation_summaries" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"summary" text,
	"folded_through" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companion_conversation_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "companion_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"role" text NOT NULL,
	"body_text" text NOT NULL,
	"tts_text" text,
	"read_aloud" boolean,
	"suggested_options" jsonb,
	"suggested_followups" jsonb,
	"news_links" jsonb,
	"submission_id" uuid,
	"model_context" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companion_messages_role_chk" CHECK ("companion_messages"."role" IN ('worker', 'bada_bhai'))
);
--> statement-breakpoint
ALTER TABLE "companion_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "companion_conversation_summaries" ADD CONSTRAINT "companion_conversation_summaries_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_messages" ADD CONSTRAINT "companion_messages_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_messages_worker_created_idx" ON "companion_messages" USING btree ("worker_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "companion_messages_created_at_idx" ON "companion_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "companion_messages_submission_uq" ON "companion_messages" USING btree ("worker_id","submission_id","role") WHERE "companion_messages"."submission_id" IS NOT NULL;--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on both tables.
--
-- The posture every worker-data table since 0071 carries (worker_feedback 0080, ai_call_traces
-- 0083, payer_applicant_stages 0134): nothing reaches these rows except the API's BYPASSRLS
-- connection. FORCE matters because it applies to the table OWNER too. `drizzle-kit generate`
-- emits only the ENABLEs above; FORCE and the eight REVOKEs are hand-written, and a regenerate
-- drops them silently.
-- ===========================================================================
ALTER TABLE "companion_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_messages" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_messages" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_messages" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_messages" FROM service_role;--> statement-breakpoint
ALTER TABLE "companion_conversation_summaries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_conversation_summaries" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_conversation_summaries" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_conversation_summaries" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "companion_conversation_summaries" FROM service_role;

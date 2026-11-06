-- ==============================================================================
-- 0158 - cost ledger: completed-profile rows that survive account deletion (B2 #2555)
-- ==============================================================================
--
-- Additive only: one new table, no FKs. Nothing existing is altered, dropped or
-- rewritten; no data backfill in SQL (the event-spine backfill
-- `db:backfill:cost-ledger` fills historical rows later).
--   * profile_completion_ledger - ONE ROW PER finished profile: profile/session/job
--     ids (opaque, deliberately FK-free so erasure cannot cascade here),
--     completed_at (the event's `occurred_at`, so backfilled rows land in their true
--     window), is_test_account (stamped at completion time), source
--     ('extraction' | 'backfill'). NULL worker_id = a completion that named no
--     worker — countable as unattributed, never dropped. NO PII beyond opaque ids.
--
-- APPLY-BEFORE-DEPLOY. Manual apply BEFORE the build that writes/reads this table
-- deploys (code auto-deploys on merge; migrations never do). The writers
-- (`ProfileExtractionProcessor` + the backfill insert) name these columns explicitly,
-- and the admin dashboard denominator reads this table — so the new build against an
-- unmigrated database 500s profile completions and the denominator read. The OLD
-- build on a migrated database is fine (a superset). Registered as
-- `0158-cost-ledger` in `schema-contract.ts`.
--
-- LOCKS. CREATE TABLE touches nothing live. The two CREATE INDEXes run on an empty
-- table (instant validation). RLS ENABLE + FORCE + REVOKE take no data locks.
--
-- RLS. The FORCE + REVOKE tail below is HAND-APPENDED, mirroring 0077: drizzle-kit
-- models ENABLE but neither FORCE nor the grant revocations, and without FORCE the
-- table asserts RLS+FORCE+no-grants per NAME in `tests/e2e/rls-spine.e2e.test.ts`
-- (LOCKED_TABLES) — add the table name there in the same change.
--
-- ROLLBACK: drop the table, then delete the journal row —
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   DROP TABLE "profile_completion_ledger";
--   DELETE FROM drizzle.__drizzle_migrations WHERE ... (this entry's journal `when`);
--   COMMIT;
-- only AFTER rolling the API back to a build that does not name it. Dropping loses
-- the stamped completions (the `profile.extraction_completed` spine events survive).
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
CREATE TABLE "profile_completion_ledger" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"chat_session_id" uuid,
	"ai_job_id" uuid,
	"worker_id" uuid,
	"completed_at" timestamp with time zone NOT NULL,
	"is_test_account" boolean NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "profile_completion_ledger_source_chk" CHECK ("profile_completion_ledger"."source" IN ('extraction', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "profile_completion_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "profile_completion_ledger_completed_idx" ON "profile_completion_ledger" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "profile_completion_ledger_worker_idx" ON "profile_completion_ledger" USING btree ("worker_id");--> statement-breakpoint
-- HAND-APPENDED (see the RLS note in this file's header). FORCE + REVOKE ALL: only the
-- API's BYPASSRLS connection may touch this table, mirroring the 0077 cost tables.
ALTER TABLE "profile_completion_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_completion_ledger" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_completion_ledger" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_completion_ledger" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_completion_ledger" FROM service_role;
-- ===========================================================================
-- 0080 — WORKER APP FEEDBACK: one new table (#997)
--
-- FULLY ADDITIVE. One NEW table, empty on arrival. Nothing is dropped, nothing is renamed, no
-- shipped column changes meaning, and no existing read or write touches it.
--
-- ORDER: APPLY BEFORE DEPLOY. `FeedbackRepository.insert` names `worker_feedback`
-- unconditionally on the request path of POST /workers/me/feedback, and the write is inside the
-- same transaction as its `feedback.submitted` event — there is no savepoint and no catch.
-- Against an unmigrated database EVERY submission 500s and the worker's typed feedback is lost
-- with it, and the admin list 500s on first page load. Recorded in `schema-contract.ts`, so
-- `pnpm --filter @badabhai/db db:audit:schema-contract` answers "is this database ready?" for
-- it, rather than anyone having to take it on report — the 0078 lesson.
--
-- TIMING (the DDL, as distinct from deploy ORDER). The one ADD CONSTRAINT ... FOREIGN KEY takes
-- SHARE ROW EXCLUSIVE on `workers`, which CONFLICTS with the ROW EXCLUSIVE every ordinary write
-- holds. Validation is instant — the new table is empty — but the lock request queues behind any
-- in-flight transaction on that hot table, and every writer arriving meanwhile queues behind IT.
-- Per the 0073/0077 precedent this is timing guidance, not a blocker: run under
-- `SET lock_timeout = '3s';` and retry on 55P03 (lock_not_available).
--
-- BACKFILL: NONE. There is no prior source of worker feedback — this table starts the record.
--
-- RLS. The FORCE + REVOKE tail below is HAND-APPENDED, mirroring 0073/0076/0077: the generator
-- models ENABLE but neither FORCE nor the grant revocations, and without FORCE the table OWNER
-- bypasses every policy — which is the only connection the backend uses, so ENABLE alone would
-- be decorative. This table matters more than most: `message` is the one column on the whole
-- spine deliberately allowed to hold a worker's own PII, so a permissive default here would
-- expose free-text personal data across the entire worker base to every PostgREST role.
--
-- ROLLBACK. Drop the table — no other table has an FK to it, no view or function selects from
-- it, and its own FK and three indexes go with it. NOT safe with the app live: unlike 0077 there
-- is no savepoint, so dropping it makes POST /workers/me/feedback 500 and GET /admin/feedback
-- 500. Revert the app first, then:
--   DROP TABLE IF EXISTS "worker_feedback";
-- Lossy by definition, and uniquely so: the rows ARE the record and the event spine carries only
-- message LENGTHS by design, so nothing reconstructs what anyone wrote. Export first if the
-- table is not empty.
-- Also listed in LOCKED_TABLES in tests/e2e/rls-spine.e2e.test.ts, which asserts
-- RLS + FORCE + no-grants per NAME — remove that entry in the same change.
--
-- MIGRATION SLOT. Renumbered 0079 -> 0080 mid-review: #992 took 0079 while this branch was in
-- flight. REGENERATED, NOT RENAMED (the 0071 rule) — a drizzle snapshot chains to its
-- predecessor by prevId, so a renamed file would still chain off 0078 and the next generate
-- would diff against a schema missing 0079 entirely. The pre-renumber file was never applied
-- to any database, so its `when` needed no pinning. MIGRATIONS.md records the claim; OIE moves
-- to 0081.
-- ===========================================================================
CREATE TABLE "worker_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"category" text,
	"message" text NOT NULL,
	"app_build" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_feedback_category_chk" CHECK ("worker_feedback"."category" IS NULL OR "worker_feedback"."category" IN ('suggestion', 'problem', 'other')),
	CONSTRAINT "worker_feedback_message_len_chk" CHECK (char_length("worker_feedback"."message") BETWEEN 1 AND 4000),
	CONSTRAINT "worker_feedback_app_build_len_chk" CHECK ("worker_feedback"."app_build" IS NULL OR char_length("worker_feedback"."app_build") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "worker_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_feedback" ADD CONSTRAINT "worker_feedback_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_feedback_worker_id_idx" ON "worker_feedback" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_feedback_admin_keyset_idx" ON "worker_feedback" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "worker_feedback_category_keyset_idx" ON "worker_feedback" USING btree ("category","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
-- HAND-APPENDED (see the RLS note in this file's header). FORCE + REVOKE ALL, so the lock is a
-- real denial on every PostgREST Data-API role rather than an ENABLE the owner walks through.
ALTER TABLE "worker_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_feedback" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_feedback" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_feedback" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_feedback" FROM service_role;

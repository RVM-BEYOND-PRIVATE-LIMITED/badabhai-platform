-- ==============================================================================
-- 0157 - admin posting control: hidden state + agency-job trust review (#2566 B12)
-- ==============================================================================
--
-- Additive only. Nothing existing is altered, dropped or rewritten; no backfill.
--   * job_postings.hidden_at / hidden_by / hidden_reason_code / hidden_reason_text
--   * jobs.hidden_at / hidden_by / hidden_reason_code / hidden_reason_text
--       BadaBhai's HIDE, a state SEPARATE from `status` (owner ruling). A hidden row keeps
--       its status, so the company still lists it ("Hidden by BadaBhai"), but every worker
--       feed/search/detail read filters `hidden_at IS NULL`. Only the admin route writes it.
--       All four NULL on every existing row = visible = today's behaviour.
--   * jobs.verification_status text NOT NULL DEFAULT 'unverified'
--       The agency job's ops trust review, mirroring job_postings.verification_status.
--       PG11+ fast default: catalog-only, no table rewrite.
--   * job_postings_hidden_state_chk / jobs_hidden_state_chk
--       Hidden is ONE state: all four columns present together, or all NULL. Every existing
--       row is all-NULL, so validation cannot fail.
--   * jobs_verification_status_chk - the same closed set as postings.
--
-- APPLY-BEFORE-DEPLOY. Manual apply BEFORE the build that reads these columns deploys
-- (code auto-deploys on merge; migrations never do). The worker feed, search and job-detail
-- reads name `hidden_at` explicitly and bare `select()` readers of both tables name every
-- model column, so the new build against an unmigrated database 500s the worker feed and
-- every posting read. The OLD build on a migrated database is fine (a superset).
-- Registered as `0157-job-postings-hidden-at` + `0157-jobs-hidden-at` in `schema-contract.ts`.
--
-- LOCKS. The ADD COLUMNs are catalog-only but take a brief ACCESS EXCLUSIVE on `job_postings`
-- and `jobs`, which the worker feed reads constantly - hence the short lock_timeout; retry on
-- 55P03. The three CHECKs scan their table under that lock (the 0141 precedent on the same
-- two tables); at today's row counts that is milliseconds.
--
-- ROLLBACK, only AFTER rolling the API back to a build that does not name these columns:
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_hidden_state_chk";
--   ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_verification_status_chk";
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_hidden_state_chk";
--   ALTER TABLE "jobs" DROP COLUMN IF EXISTS "hidden_reason_text", DROP COLUMN IF EXISTS "hidden_reason_code",
--     DROP COLUMN IF EXISTS "hidden_by", DROP COLUMN IF EXISTS "hidden_at", DROP COLUMN IF EXISTS "verification_status";
--   ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "hidden_reason_text", DROP COLUMN IF EXISTS "hidden_reason_code",
--     DROP COLUMN IF EXISTS "hidden_by", DROP COLUMN IF EXISTS "hidden_at";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793884554348;
--   COMMIT;
-- Dropping them un-hides every hidden posting (they return to the worker feed) and loses
-- every agency job's review; the audit_logs rows and admin.action_performed events survive.
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "hidden_by" uuid;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "hidden_reason_code" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "hidden_reason_text" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "verification_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "hidden_by" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "hidden_reason_code" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "hidden_reason_text" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_hidden_state_chk" CHECK (("job_postings"."hidden_at" IS NULL AND "job_postings"."hidden_by" IS NULL AND "job_postings"."hidden_reason_code" IS NULL AND "job_postings"."hidden_reason_text" IS NULL)
        OR ("job_postings"."hidden_at" IS NOT NULL AND "job_postings"."hidden_by" IS NOT NULL AND "job_postings"."hidden_reason_code" IS NOT NULL AND "job_postings"."hidden_reason_text" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_verification_status_chk" CHECK ("jobs"."verification_status" IN ('unverified', 'verified', 'rejected'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_hidden_state_chk" CHECK (("jobs"."hidden_at" IS NULL AND "jobs"."hidden_by" IS NULL AND "jobs"."hidden_reason_code" IS NULL AND "jobs"."hidden_reason_text" IS NULL)
        OR ("jobs"."hidden_at" IS NOT NULL AND "jobs"."hidden_by" IS NOT NULL AND "jobs"."hidden_reason_code" IS NOT NULL AND "jobs"."hidden_reason_text" IS NOT NULL));
-- ROLLBACK: ALTER TABLE "jobs" DROP COLUMN IF EXISTS "applicants_received"; (also drop the CHECK)
ALTER TABLE "jobs" ADD COLUMN "applicants_received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_applicants_received_nonneg_chk" CHECK ("jobs"."applicants_received" >= 0);
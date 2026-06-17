-- ROLLBACK: ALTER TABLE "jobs"
--   DROP CONSTRAINT IF EXISTS "jobs_pay_nonneg_chk", DROP CONSTRAINT IF EXISTS "jobs_pay_order_chk",
--   DROP CONSTRAINT IF EXISTS "jobs_experience_nonneg_chk", DROP CONSTRAINT IF EXISTS "jobs_experience_order_chk",
--   DROP CONSTRAINT IF EXISTS "jobs_needed_by_chk",
--   DROP COLUMN IF EXISTS "pay_min", DROP COLUMN IF EXISTS "pay_max",
--   DROP COLUMN IF EXISTS "min_experience_years", DROP COLUMN IF EXISTS "max_experience_years",
--   DROP COLUMN IF EXISTS "needed_by";
-- Additive only (new nullable columns + CHECKs on `jobs`); no data rewrite. ADR-0011 Reach-on-real-jobs.
ALTER TABLE "jobs" ADD COLUMN "pay_min" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "pay_max" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "min_experience_years" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_experience_years" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "needed_by" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pay_nonneg_chk" CHECK (("jobs"."pay_min" IS NULL OR "jobs"."pay_min" >= 0) AND ("jobs"."pay_max" IS NULL OR "jobs"."pay_max" >= 0));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pay_order_chk" CHECK ("jobs"."pay_min" IS NULL OR "jobs"."pay_max" IS NULL OR "jobs"."pay_max" >= "jobs"."pay_min");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_experience_nonneg_chk" CHECK (("jobs"."min_experience_years" IS NULL OR "jobs"."min_experience_years" >= 0) AND ("jobs"."max_experience_years" IS NULL OR "jobs"."max_experience_years" >= 0));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_experience_order_chk" CHECK ("jobs"."min_experience_years" IS NULL OR "jobs"."max_experience_years" IS NULL OR "jobs"."max_experience_years" >= "jobs"."min_experience_years");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_needed_by_chk" CHECK ("jobs"."needed_by" IS NULL OR "jobs"."needed_by" IN ('immediate', 'soon', 'flexible'));
-- ROLLBACK: ALTER TABLE "jobs"
--   DROP CONSTRAINT IF EXISTS "jobs_shift_chk",
--   DROP COLUMN IF EXISTS "description", DROP COLUMN IF EXISTS "shift",
--   DROP COLUMN IF EXISTS "benefits", DROP COLUMN IF EXISTS "requirements";
--   (Rollback is safe: readers are feature-new and null-tolerant.)
-- Additive only (new nullable columns + a CHECK on `jobs`); no data rewrite. ADR-0024 final addendum (2026-07-16) — worker-visible job content.
ALTER TABLE "jobs" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "shift" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "benefits" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "requirements" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_shift_chk" CHECK ("jobs"."shift" IS NULL OR "jobs"."shift" IN ('day', 'night', 'rotational'));
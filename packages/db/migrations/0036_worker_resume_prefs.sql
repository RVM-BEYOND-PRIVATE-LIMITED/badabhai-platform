-- Worker-controlled resume display prefs (the "Aap control karte hain" edit screen).
-- ADDITIVE + backward-compatible: two NON-PII boolean columns with defaults, so
-- existing rows backfill without a data migration and older code ignores them.
-- Rollback (safe, no data loss on the identity spine):
--   ALTER TABLE "workers" DROP COLUMN "resume_night_shift_ready";
--   ALTER TABLE "workers" DROP COLUMN "resume_show_photo";
ALTER TABLE "workers" ADD COLUMN "resume_show_photo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "resume_night_shift_ready" boolean DEFAULT false NOT NULL;
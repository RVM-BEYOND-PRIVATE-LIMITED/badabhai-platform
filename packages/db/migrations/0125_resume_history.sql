-- ===========================================================================
-- 0125 - resume history (ADR-0043)
--
-- PURELY ADDITIVE. Four nullable columns, one FK, two indexes, two NULL-tolerant CHECKs over
-- closed vocabularies. No backfill, no rewrite, nothing dropped.
--
-- WHAT IT RECORDS. Owner rulings 2026-09-24: every AI resume generation is its own history
-- entry, the worker is shown the newest three, and each entry says which flow made it
-- (form / chat / resume upload). Nothing is ever deleted (ruling R4, "keep all, show 3").
--
--   generated_resumes.generation_source   form | chat | resume_upload - the label on the card
--   generated_resumes.generation_trigger  profile_confirmed | manual | chat_update_accepted |
--                                         ops_regenerate - what started the generation
--   generated_resumes_worker_generated_idx (worker_id, generated_at DESC, id DESC) - the one
--       definition of "the worker's current resume" and the history read. `version` is not a
--       history ordinal (a new profile's first resume is its own v1), so ordering by it hid a
--       newer profile's resume behind an older profile's v2.
--   worker_profiles.seeded_from_import_id  the CV import this profile's interview accepted
--       (ruling R1: an accepted import labels the resume `resume_upload`). ON DELETE SET NULL.
--   worker_profiles_seeded_from_import_idx  PARTIAL (IS NOT NULL) - backs that SET NULL. Without
--       it every deleted import (account deletion cascades them) scans all of worker_profiles:
--       measured at ~99% of the trigger time of a 100-worker deletion (1305 ms -> 1.4 ms).
--   worker_profiles.resume_update_accepted_at  when the worker said "Haan" to "Resume update
--       kar doon?" - the only thing that lets the auto-generate run for a worker who already
--       has a resume.
--
-- NULL IS NOT A FACT on any of the four columns. It means "written before 0125" (or, for the
-- source, a profile whose own road was never recorded - pre-0107). Readers show no label rather
-- than guess one.
--
-- APPLY BEFORE DEPLOY. Drizzle names every schema column in every `select().from(...)`, and
-- both tables are read on hot paths: every resume read (Resume tab, GET /workers/me/profile,
-- the render worker, employer disclosure) and every profile read. A build carrying this code
-- against a database without these columns fails ALL of them with "column does not exist".
-- Registered as `0125-resume-history-*` in `schema-contract.ts`.
--
-- LOCKS - READ THIS BEFORE APPLYING TO A LIVE DATABASE. drizzle runs every pending migration in
-- ONE transaction, so the locks below are held from the first ADD COLUMN until COMMIT, not per
-- statement: ACCESS EXCLUSIVE on generated_resumes and worker_profiles (every read and write of
-- both waits), SHARE ROW EXCLUSIVE on worker_resume_import (writes wait). Measured ~170 ms end to
-- end on 100k profiles / 200k resumes. The risk is the WAIT, not the work: queued behind a
-- long-running transaction, the apply stalls every profile and resume read. Apply with a lock
-- timeout and retry on 55P03 (the 0109/0115 guidance):  SET lock_timeout = '3s';
--
-- ROLLBACK. REVERT THE APP DEPLOY FIRST - the code that ships with this migration names these
-- columns unconditionally, so dropping them under it fails every resume and profile read. Then:
--
--   ALTER TABLE "generated_resumes" DROP CONSTRAINT "generated_resumes_generation_trigger_chk";
--   ALTER TABLE "generated_resumes" DROP CONSTRAINT "generated_resumes_generation_source_chk";
--   DROP INDEX "worker_profiles_seeded_from_import_idx";
--   DROP INDEX "generated_resumes_worker_generated_idx";
--   ALTER TABLE "worker_profiles" DROP CONSTRAINT "worker_profiles_seeded_from_import_id_worker_resume_import_id_fk";
--   ALTER TABLE "worker_profiles" DROP COLUMN "resume_update_accepted_at";
--   ALTER TABLE "worker_profiles" DROP COLUMN "seeded_from_import_id";
--   ALTER TABLE "generated_resumes" DROP COLUMN "generation_trigger";
--   ALTER TABLE "generated_resumes" DROP COLUMN "generation_source";
--
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at is
-- this entry's journal `when`), or drizzle's watermark skips re-applying 0125 forever.
-- ===========================================================================
ALTER TABLE "generated_resumes" ADD COLUMN "generation_source" text;--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD COLUMN "generation_trigger" text;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "seeded_from_import_id" uuid;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "resume_update_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_seeded_from_import_id_worker_resume_import_id_fk" FOREIGN KEY ("seeded_from_import_id") REFERENCES "public"."worker_resume_import"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_resumes_worker_generated_idx" ON "generated_resumes" USING btree ("worker_id","generated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "worker_profiles_seeded_from_import_idx" ON "worker_profiles" USING btree ("seeded_from_import_id") WHERE "worker_profiles"."seeded_from_import_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD CONSTRAINT "generated_resumes_generation_source_chk" CHECK ("generated_resumes"."generation_source" IS NULL OR "generated_resumes"."generation_source" IN ('form', 'chat', 'resume_upload'));--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD CONSTRAINT "generated_resumes_generation_trigger_chk" CHECK ("generated_resumes"."generation_trigger" IS NULL OR "generated_resumes"."generation_trigger" IN ('profile_confirmed', 'manual', 'chat_update_accepted', 'ops_regenerate'));
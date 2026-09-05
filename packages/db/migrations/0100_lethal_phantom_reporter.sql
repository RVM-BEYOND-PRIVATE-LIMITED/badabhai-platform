-- ===========================================================================
-- 0100 — resume_night_shift_ready becomes THREE-STATE (#1426)
--
-- !! THE JOURNAL `when` FOR THIS ENTRY IS PINNED. DO NOT REGENERATE BLINDLY. !!
-- Re-running `drizzle-kit generate` stamps a NEW `when`; drizzle skips any entry whose
-- `when` is below MAX(created_at) in `__drizzle_migrations`, so a re-stamped 0100 can be
-- silently skipped or re-run. Regenerate only together with the backfill below.
--
-- WHAT CHANGES. `workers.resume_night_shift_ready` was `boolean NOT NULL DEFAULT false`, so
-- "the worker never answered" and "the worker said no" were the same byte. That is fine while
-- the only writer is the worker's own Edit-Resume toggle, and wrong the moment anything wants
-- to DERIVE a default from the onboarding shift answer: a derivation cannot tell whether it is
-- filling a blank or overwriting a deliberate "no".
--
-- BOTH THE DEFAULT AND THE NOT NULL GO. Dropping only the NOT NULL would land every new row on
-- `false` and reproduce the exact ambiguity this migration exists to remove, while looking
-- fixed. Verified from the generated SQL below, not assumed.
--
-- NEITHER STATEMENT REWRITES THE TABLE. In Postgres, DROP DEFAULT and DROP NOT NULL are
-- catalogue-only changes: no row is touched and no lock is held beyond the DDL itself.
--
-- ROLLBACK is the pair of inverses, and the NOT NULL direction needs a backfill of its own
-- (`UPDATE workers SET resume_night_shift_ready = false WHERE resume_night_shift_ready IS NULL`)
-- before `SET NOT NULL` will take. Reversible, not free.
-- ===========================================================================
ALTER TABLE "workers" ALTER COLUMN "resume_night_shift_ready" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "resume_night_shift_ready" DROP NOT NULL;

--> statement-breakpoint
-- ===========================================================================
-- THE BACKFILL, AND WHY IT READS THE EVENT SPINE (owner ruling 2026-09-05)
--
-- Every existing row is `false`, and under the old column that is indistinguishable from an
-- explicit "no". Leaving them all `false` means the new default can never fire for anyone who
-- signed up before this deploy; turning them all NULL erases the deliberate "no" of every
-- worker who really did open Edit Resume and leave the toggle off.
--
-- The spine already knows which is which. `worker.resume_prefs_updated` is emitted on EVERY
-- successful PATCH /workers/me/resume-prefs and on nothing else, so its presence for a worker
-- IS the record that they opened that screen and saved. A worker with no such event has never
-- expressed a view, and their `false` is the column default rather than an answer.
--
-- DELIBERATELY KEYED ON THE EVENT'S EXISTENCE, NOT ON ITS PAYLOAD VALUE. The shipped client
-- always sends BOTH flags (`api_client.dart` updateResumePrefs), so a worker who saved only to
-- change the photo still submitted the night-shift toggle in the state they could see on screen.
-- That is an answer, and it is preserved.
--
-- ONLY TOUCHES `false`. A row already `true` is an answer by construction — nothing but the
-- worker's own toggle has ever been able to write it.
-- ===========================================================================
UPDATE "workers" w
   SET "resume_night_shift_ready" = NULL
 WHERE w."resume_night_shift_ready" = false
   AND NOT EXISTS (
         SELECT 1
           FROM "events" e
          WHERE e."event_name" = 'worker.resume_prefs_updated'
            AND e."subject_type" = 'worker'
            AND e."subject_id" = w."id"
       );

-- ==============================================================================
-- 0128 - worker_resume_skin: the colour skin a worker chose for their résumé
-- ==============================================================================
--
-- #1801 (owner ruling 2026-09-28, "Plumbing, Neela only"). One row per worker: the
-- skin every future and re-rendered `bb_trade` sheet of theirs prints in. A skin is a
-- `:root` colour-token block swapped in by the renderer - never markup, never a
-- template id - so nothing about a generated_resumes row changes.
--
-- NO ROW MEANS NEELA, the house style every `bb_trade` sheet has printed in since it
-- shipped. `wrs_skin_chk` is CLOSED over `RESUME_SKINS` in @badabhai/types, which is
-- `neela` alone today: Saada / Kaagaz / Loha have no approved tokens. A new skin widens
-- this CHECK in its own migration, together with its token block and a new
-- `resume.skin_changed` event version.
--
-- A SEPARATE TABLE, NOT A COLUMN on `workers` or `generated_resumes`. A bare select on
-- either names every model column, so a column there would 500 every worker or résumé
-- read on a build that reaches this database before this migration does (the
-- 2026-09-10 form outage). NOT PII: an opaque worker id, a closed skin, a timestamp.
-- Erasure is the worker_id cascade.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE FLAG, NOT BEFORE THE DEPLOY. Every read and write of
-- this table (`ResumeSkinRepository`, via GET/PUT /resume/skin and the render worker)
-- sits behind RESUME_SKINS_ENABLED (default off), so a deploy ahead of this migration
-- breaks no request. Order: merge -> apply 0128 -> set the production-environment
-- secret RESUME_SKINS_ENABLED=true. Turning the flag on against a database without this
-- table 500s both skin routes and costs every trade-sheet render its skin read (the
-- render degrades to Neela and still produces the PDF). Registered as
-- `0128-worker-resume-skin-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the
-- e2e RLS spine.
--
-- LOCKS. CREATE TABLE touches nothing live; the FK takes a SHARE ROW EXCLUSIVE lock on
-- `workers` for the (empty-table, instant) validation. That lock still queues behind any
-- long-running transaction on `workers` and blocks writers behind it, so apply inside one
-- BEGIN/COMMIT with `SET LOCAL lock_timeout = '3s';` and retry on 55P03 (the 0073/0077/0080
-- precedent in MIGRATIONS.md).
--
-- ROLLBACK (after turning RESUME_SKINS_ENABLED off - nothing else reads it):
--   DROP TABLE "worker_resume_skin";
-- Dropping it loses only the skins workers chose; with the flag off every sheet prints
-- in Neela, exactly as before this migration.
-- ==============================================================================
CREATE TABLE "worker_resume_skin" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"skin" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wrs_skin_chk" CHECK ("worker_resume_skin"."skin" IN ('neela'))
);
--> statement-breakpoint
ALTER TABLE "worker_resume_skin" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_resume_skin" ADD CONSTRAINT "worker_resume_skin_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
--
-- The same posture every worker-data table since 0071 carries (worker_certificate,
-- worker_education, profile_correction, worker_profiling_tier): nothing reaches these
-- rows except the API's BYPASSRLS connection. FORCE matters because it applies to the
-- table OWNER too. `drizzle-kit generate` emits only the ENABLE above; FORCE and the
-- four REVOKEs are hand-written, and a regenerate drops them silently.
-- ===========================================================================
ALTER TABLE "worker_resume_skin" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_skin" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_skin" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_skin" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_skin" FROM service_role;

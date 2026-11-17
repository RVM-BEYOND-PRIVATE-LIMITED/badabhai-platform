-- ==============================================================================
-- job_posting_worker_visibility: BadaBhai worker visibility of a Campus-origin posting (#2891)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- Ruling of 17 Nov 2026 (Akshit and Prakash, #2891): every job created on BadaBhai Campus also
-- comes to BadaBhai, and shows to BadaBhai workers only after an admin turns its worker
-- visibility on. One row per Campus-origin posting, written `off` before the posting can be
-- seen; `reachesBadaBhaiWorkers()` hides a posting whose row says `off` on every worker path and
-- in the reach core. A posting with no row is not Campus-origin and is untouched. The RVM review
-- (`job_posting_institute_reviews`) stays separate and nothing here is in its content hash.
--
-- ADDITIVE ONLY. One new, EMPTY table, one index and one foreign key; no existing column,
-- constraint or row moves. Nothing is seeded or backfilled: a Campus posting made before this
-- change has the `rvm_students` audience, which already keeps it off every worker path.
--
-- DEPLOY ORDER - APPLY BEFORE THE DEPLOY OF THE CODE THAT READS IT. This migration's own PR
-- names the table in the drizzle model and in `holdPostingFromWorkers` only, and nothing calls
-- either, so it is safe to merge and deploy before the apply. The FOLLOWING #2891 PR puts the
-- table inside `reachesBadaBhaiWorkers()`, which every worker read runs UNCONDITIONALLY (the
-- audience lock has no switch, by rule): deployed against a database without this table, the
-- worker feed, search, job detail, apply and every reach write fail with 42P01. So: apply every
-- lower-numbered migration first (slot order), then this, THEN merge the next #2891 PR.
--
-- LOCKS. The new table is empty. The foreign key takes a brief SHARE ROW EXCLUSIVE lock on
-- `job_postings` (blocks its writes, not its reads, for the instant the constraint is added;
-- nothing to validate). Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;`
-- and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 pattern) - a regenerate drops them silently.
-- Registered in `schema-contract.ts` and listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (only while no deployed code names the table: revert the reading PR and redeploy
-- first, or every worker read fails; every visibility decision is lost, and every Campus-origin
-- posting with the `both` audience then reaches BadaBhai workers at once):
--   DROP TABLE "job_posting_worker_visibility";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "job_posting_worker_visibility" (
	"job_posting_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'off' NOT NULL,
	"origin" text NOT NULL,
	"decided_by_admin_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jpwv_state_chk" CHECK ("job_posting_worker_visibility"."state" IN ('off', 'on')),
	CONSTRAINT "jpwv_origin_chk" CHECK ("job_posting_worker_visibility"."origin" IN ('campus_posted', 'campus_imported')),
	CONSTRAINT "jpwv_decision_chk" CHECK (("job_posting_worker_visibility"."decided_at" IS NULL) = ("job_posting_worker_visibility"."decided_by_admin_id" IS NULL)
        AND ("job_posting_worker_visibility"."state" = 'off' OR "job_posting_worker_visibility"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "job_posting_worker_visibility" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_posting_worker_visibility" ADD CONSTRAINT "job_posting_worker_visibility_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jpwv_state_created_idx" ON "job_posting_worker_visibility" USING btree ("state","created_at");
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 pattern), because a
-- regenerate drops them.
-- ===========================================================================
ALTER TABLE "job_posting_worker_visibility" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_worker_visibility" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_worker_visibility" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_worker_visibility" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_worker_visibility" FROM service_role;

-- ==============================================================================
-- 0134 - payer_applicant_stages: the applicant pipeline board, saved server-side
-- ==============================================================================
--
-- Owner ruling 2026-10-07. payer-web's per-posting New / Shortlist / Passed board was local
-- React state: lost on reload and never shared. This table stores it. One row per
-- (posting kind, posting id, worker): `posting_kind` says which table the posting is in
-- (`agency_job` = a legacy `jobs` row, `company_posting` = a `job_postings` row), the same two
-- kinds GET /payer/reach/applicants reports as `posting.kind`.
--
-- NO ROW MEANS `new`. A row moved back to New stores `new` explicitly (one write path, and the
-- row keeps who moved it back and when); every reader reads COALESCE(stage, 'new').
--
-- KEYS AND INDEXES. The composite PRIMARY KEY (posting_kind, posting_id, worker_id) is the
-- natural key, the upsert target, and the index both reads use: the per-posting feed reads one
-- posting's rows (PK prefix), the inbox probes one row per listed application (the full PK) and
-- applies its optional stage filter to that row. `payer_applicant_stages_worker_id_idx` backs the
-- worker_id ON DELETE CASCADE (erasure). `posting_id` has NO foreign key - it names a row in one
-- of two tables.
--
-- TENANCY (ADR-0053 §4, class C "via parent"): NO tenant column. ACCESS IS POSTING OWNERSHIP,
-- decided by the API through the posting-ownership chokepoint (`findOwnedJobRef`), never by a
-- column here - so the board becomes org-scoped at the PAY-DB-01 flip with no change of its own.
-- `actor_payer_id` records the acting login that last moved the row (ADR-0053 §3.1: an actor is
-- never a second `payer_id`); it is never an access rule, and has no foreign key.
--
-- NOT PII: opaque ids, two closed vocabularies, timestamps. Erasure is the worker_id cascade.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE FLAG, NOT BEFORE THE DEPLOY. Every read and write of this
-- table (PayerApplicantStagesRepository, the inbox page read) sits behind
-- PAYER_APPLICANT_STAGES_ENABLED (default off), so a deploy ahead of this migration breaks no
-- request: with the flag off the feeds carry no `stage`, the stage route is a 404 and nothing
-- names the table. Turning the flag on against a database without this table 500s BOTH applicant
-- feeds and the stage route. Registered as `0134-payer-applicant-stages-rls` in
-- `schema-contract.ts`, so `db:audit:schema-contract` reports it missing on any database that
-- has not applied it yet (expected until step 3 below); listed in LOCKED_TABLES in the e2e RLS
-- spine.
--
--   1. Merge (the deploy is safe; the flag is off).
--   2. Run `adopt-migrations.ts` verify-only with NO --only, and adopt every clean entry below
--      0134 in one run. Any entry that fails verification must be APPLIED first: once a later
--      row is recorded, `db:migrate` skips every journal entry below MAX(created_at), applied or
--      not (adopt-migrations itself can still record rows below the watermark).
--   3. Apply this file in ONE transaction:  BEGIN; SET LOCAL lock_timeout = '3s'; <statements>;
--      COMMIT;  and retry on 55P03.
--   4. Adopt 0134's ledger row and run `db:audit:schema-contract`.
--   5. Set the production-environment secret PAYER_APPLICANT_STAGES_ENABLED=true and redeploy.
--
-- LOCKS. CREATE TABLE touches nothing live. The FK takes SHARE ROW EXCLUSIVE on `workers` for its
-- (empty-table, instant) validation; that lock still queues behind any long-running transaction
-- on `workers` and blocks writers behind it - hence the lock_timeout and retry. Dropping the
-- table (rollback) is heavier: removing the FK's referential-integrity triggers takes ACCESS
-- EXCLUSIVE on `workers`, which blocks every worker read and write while it waits, so the
-- rollback needs the same lock_timeout and retry.
--
-- ROLLBACK, in this order (config is read at boot, so the flag change needs a redeploy):
--   1. Set PAYER_APPLICANT_STAGES_ENABLED=false and REDEPLOY.
--   2. Confirm the applicant feeds no longer carry `stage` (nothing names the table any more).
--   3. In ONE transaction, retrying on 55P03:
--        BEGIN;
--        SET LOCAL lock_timeout = '3s';
--        DROP TABLE "payer_applicant_stages";
--        DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791438567323;
--        COMMIT;
--      (1791438567323 is this entry's journal `when`; without deleting its row, drizzle's
--      watermark never re-applies 0134.)
-- Dropping it loses every saved board; with the flag off payer-web keeps its local board,
-- exactly as before this migration.
-- ==============================================================================
CREATE TABLE "payer_applicant_stages" (
	"posting_kind" text NOT NULL,
	"posting_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"actor_payer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_applicant_stages_pkey" PRIMARY KEY("posting_kind","posting_id","worker_id"),
	CONSTRAINT "payer_applicant_stages_posting_kind_chk" CHECK ("payer_applicant_stages"."posting_kind" IN ('company_posting', 'agency_job')),
	CONSTRAINT "payer_applicant_stages_stage_chk" CHECK ("payer_applicant_stages"."stage" IN ('new', 'shortlist', 'passed'))
);
--> statement-breakpoint
ALTER TABLE "payer_applicant_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_applicant_stages" ADD CONSTRAINT "payer_applicant_stages_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payer_applicant_stages_worker_id_idx" ON "payer_applicant_stages" USING btree ("worker_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
--
-- The posture every payer and worker table since 0071 carries (worker_resume_skin 0128,
-- relay_messages 0120): nothing reaches these rows except the API's BYPASSRLS connection. FORCE
-- matters because it applies to the table OWNER too. `drizzle-kit generate` emits only the
-- ENABLE above; FORCE and the four REVOKEs are hand-written, and a regenerate drops them silently.
-- ===========================================================================
ALTER TABLE "payer_applicant_stages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_applicant_stages" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_applicant_stages" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_applicant_stages" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_applicant_stages" FROM service_role;

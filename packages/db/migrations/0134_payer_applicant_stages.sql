-- ==============================================================================
-- 0134 - payer_applicant_stages: the applicant pipeline board, saved server-side
-- ==============================================================================
--
-- Owner ruling 2026-10-07. payer-web's per-posting New / Shortlist / Passed board was local
-- React state: lost on reload and never shared with teammates. This table stores it. One row per
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
-- of two tables - and `updated_by_payer_id` has none either (the faceless-rails convention of
-- `jobs.payer_id` / `job_postings.payer_id`). ACCESS IS POSTING OWNERSHIP, decided by the API
-- with the feeds' own ownership check, never by `updated_by_payer_id`.
--
-- NOT PII: opaque ids, two closed vocabularies, timestamps. Erasure is the worker_id cascade.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE FLAG, NOT BEFORE THE DEPLOY. Every read and write of this
-- table (PayerApplicantStagesRepository, the inbox page read) sits behind
-- PAYER_APPLICANT_STAGES_ENABLED (default off), so a deploy ahead of this migration breaks no
-- request: with the flag off the feeds carry no `stage`, the stage route is a 404 and nothing
-- names the table. Order: merge -> apply 0134 -> set the production-environment secret
-- PAYER_APPLICANT_STAGES_ENABLED=true -> redeploy. Turning the flag on against a database without
-- this table 500s BOTH applicant feeds and the stage route. Registered as
-- `0134-payer-applicant-stages-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the e2e
-- RLS spine.
--
-- LOCKS. CREATE TABLE touches nothing live; the FK takes a SHARE ROW EXCLUSIVE lock on `workers`
-- for the (empty-table, instant) validation. That lock still queues behind any long-running
-- transaction on `workers` and blocks writers behind it, so apply inside one BEGIN/COMMIT with
-- `SET LOCAL lock_timeout = '3s';` and retry on 55P03 (the 0128 precedent).
--
-- ROLLBACK (after turning PAYER_APPLICANT_STAGES_ENABLED off - nothing else reads it):
--   DROP TABLE "payer_applicant_stages";
-- Dropping it loses every saved board; with the flag off payer-web keeps its local board, exactly
-- as before this migration. Then delete this migration's row from drizzle.__drizzle_migrations
-- (created_at = this entry's journal `when`), or drizzle's watermark never re-applies 0134.
-- ==============================================================================
CREATE TABLE "payer_applicant_stages" (
	"posting_kind" text NOT NULL,
	"posting_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"updated_by_payer_id" uuid NOT NULL,
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

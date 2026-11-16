-- ==============================================================================
-- 0168 - hires: one hire record per company, worker and posting
-- ==============================================================================
--
-- #2753 item 9. A hire is said by the company's board (a real move INTO `hired`, #2747),
-- by the company's follow-up answer (item 10) and by the worker's own monthly-check answer
-- (item 5); the worker desk confirms or rejects it. HiresService upserts ONE row per
-- (tenant_payer_id, worker_id, posting_kind, posting_id) for all of them, in the CALLER's
-- transaction, and emits `hire.recorded` on each real change. Only the board source is
-- wired today (PayerApplicantStagesService, the stage transaction).
--
-- STATES. `reported` (one side said so: the worker's own answer, owner question 2 default),
-- `confirmed` (a company mark or answer, or the desk), `rejected` (the desk, or the company
-- moving him out of `hired` when nothing else confirmed it). Only `confirmed` counts toward
-- the target. HOW IT WAS CONFIRMED: one timestamp per source, set once, never cleared;
-- `hired_on` is the IST day of the first confirming source.
--
-- IDS ONLY. Ids, dates and closed codes: no name, phone, title or note. Not PII beyond the
-- worker id (erasure is the cascade below). `tenant_payer_id` is the company's TENANT key
-- (PayerTenantScopeService), the key the stage board resolves ownership with; `posting_id`
-- has no FK (one column names a `jobs` or a `job_postings` row, as on
-- `payer_applicant_stages`).
--
-- KEYS AND INDEXES. `hires_tenant_worker_posting_uq` is the upsert target every source
-- writes through (and its index serves the per-key lock). `hires_worker_id_idx` backs the
-- worker_id ON DELETE CASCADE (erasure removes a worker's hire records); the tenant FK
-- cascades with the payer, as `feature_pilot_payers` does.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table
-- while HIRE_RECORDS_ENABLED (default false) is off: the stage transaction writes nothing
-- here and GET /admin/hires is a 404. With the switch on before 0168, a company's move into
-- or out of `hired` fails (42P01): the stage transaction rolls back, nothing is written, the
-- request answers 500; GET /admin/hires answers 500. Apply 0164 to 0167 first (slot
-- order), then this.
--
-- LOCKS. CREATE TABLE is instant, but each FOREIGN KEY takes SHARE ROW EXCLUSIVE on its
-- parent - `payers` and `workers` - which blocks writes to them while it waits behind a long
-- transaction. Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and
-- retry on 55P03 (the 0129 / 0130 / 0166 / 0167 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 pattern) - a regenerate drops them silently. Registered as
-- `0168-hires-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch off and redeploy first; the records are lost - they cannot be rebuilt
-- from the board alone, since the company and worker answers live only here):
--   DROP TABLE "hires";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose
-- created_at is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "hires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_payer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"posting_kind" text NOT NULL,
	"posting_id" uuid NOT NULL,
	"status" text NOT NULL,
	"company_marked_at" timestamp with time zone,
	"company_answered_at" timestamp with time zone,
	"worker_answered_at" timestamp with time zone,
	"desk_confirmed_at" timestamp with time zone,
	"hired_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hires_tenant_worker_posting_uq" UNIQUE("tenant_payer_id","worker_id","posting_kind","posting_id"),
	CONSTRAINT "hires_posting_kind_chk" CHECK ("hires"."posting_kind" IN ('company_posting', 'agency_job')),
	CONSTRAINT "hires_status_chk" CHECK ("hires"."status" IN ('reported', 'confirmed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "hires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hires" ADD CONSTRAINT "hires_tenant_payer_id_payers_id_fk" FOREIGN KEY ("tenant_payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hires" ADD CONSTRAINT "hires_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hires_worker_id_idx" ON "hires" USING btree ("worker_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "hires" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hires" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "hires" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "hires" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hires" FROM service_role;

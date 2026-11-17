-- ==============================================================================
-- company_import_batches + company_import_rows: the Campus company import ledger (#2754 item 4)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2754 items 4 and 14. Companies move from BadaBhai Campus to BadaBhai through
-- `import-campus-companies.cli.ts`, which reads the export bundle of RVMBeyond_jobportal#156.
-- Every run must be repeatable and reversible by batch, so the import keeps its own ledger:
--
-- `company_import_batches`: one row per `--apply` run (a named batch), with the bundle's format,
-- version, generation time and manifest sha256, whether it is a test or pilot batch of our own
-- dummy companies, who ran it, and when it was applied or rolled back. Counts only, no PII.
--
-- `company_import_rows`: one row per source record (company, job, application, balance, carried
-- access), unique on (source system, kind, source id) ACROSS batches, so a second run adds
-- nothing. It maps each Campus id to the BadaBhai row written or matched, or says why nothing
-- moved (held, skipped, exception). `detail` holds ids, counts and codes, never a name, phone,
-- email or GSTIN.
--
-- The source-to-target map lives HERE, not as new columns on `job_postings` or `applications`:
-- both are read with bare selects, so a column there would be apply-before-deploy (MIGRATIONS.md
-- 0131 / 0132 / 0159).
--
-- ADDITIVE ONLY. Two new, EMPTY tables, their indexes and one foreign key between them; no
-- existing table, column, constraint or row is touched. Nothing is seeded.
--
-- DEPLOY ORDER - APPLY BEFORE THE FIRST IMPORT RUN, NOT BEFORE THE DEPLOY. Only the import CLI
-- names these tables; no route, sweep or read path does. A deploy ahead of this file breaks
-- nothing. The CLI refuses `--apply` when the tables are missing.
--
-- LOCKS. Two new empty tables and a foreign key between them: no lock on any existing table.
-- Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;`.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 pattern) - a regenerate drops them
-- silently. Both tables are registered as `rls` entries in `schema-contract.ts` and listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (only before any batch is applied, or after every batch is rolled back with the CLI;
-- dropping these tables loses the map that `--rollback` needs):
--   DROP TABLE "company_import_rows";
--   DROP TABLE "company_import_batches";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "company_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_key" text NOT NULL,
	"source_system" text NOT NULL,
	"bundle_format" text NOT NULL,
	"bundle_version" integer NOT NULL,
	"bundle_generated_at" timestamp with time zone NOT NULL,
	"manifest_sha256" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'applying' NOT NULL,
	"run_by" text NOT NULL,
	"manifest_counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"rolled_back_by" text,
	CONSTRAINT "company_import_batches_source_chk" CHECK ("company_import_batches"."source_system" IN ('campus')),
	CONSTRAINT "company_import_batches_state_chk" CHECK ("company_import_batches"."state" IN ('applying', 'applied', 'rolled_back')),
	CONSTRAINT "company_import_batches_text_chk" CHECK (char_length("company_import_batches"."batch_key") BETWEEN 1 AND 64 AND char_length("company_import_batches"."run_by") BETWEEN 1 AND 128 AND char_length("company_import_batches"."manifest_sha256") = 64 AND ("company_import_batches"."rolled_back_by" IS NULL OR char_length("company_import_batches"."rolled_back_by") BETWEEN 1 AND 128)),
	CONSTRAINT "company_import_batches_rollback_chk" CHECK (("company_import_batches"."state" = 'rolled_back') = ("company_import_batches"."rolled_back_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "company_import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "company_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"company_source_id" text,
	"target_id" uuid,
	"state" text NOT NULL,
	"reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_import_rows_source_chk" CHECK ("company_import_rows"."source_system" IN ('campus')),
	CONSTRAINT "company_import_rows_kind_chk" CHECK ("company_import_rows"."kind" IN ('company', 'job', 'application', 'balance', 'access')),
	CONSTRAINT "company_import_rows_state_chk" CHECK ("company_import_rows"."state" IN ('created', 'matched', 'held', 'skipped', 'exception', 'rolled_back')),
	CONSTRAINT "company_import_rows_target_chk" CHECK (("company_import_rows"."state" IN ('created', 'matched', 'rolled_back')) = ("company_import_rows"."target_id" IS NOT NULL)),
	CONSTRAINT "company_import_rows_reason_chk" CHECK (("company_import_rows"."state" IN ('held', 'skipped', 'exception')) <= ("company_import_rows"."reason" IS NOT NULL) AND ("company_import_rows"."reason" IS NULL OR char_length("company_import_rows"."reason") BETWEEN 1 AND 64)),
	CONSTRAINT "company_import_rows_text_chk" CHECK (char_length("company_import_rows"."source_id") BETWEEN 1 AND 200 AND ("company_import_rows"."company_source_id" IS NULL OR char_length("company_import_rows"."company_source_id") BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "company_import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_import_rows" ADD CONSTRAINT "company_import_rows_batch_id_company_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."company_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_import_batches_batch_key_uq" ON "company_import_batches" USING btree ("batch_key");--> statement-breakpoint
CREATE UNIQUE INDEX "company_import_rows_source_uq" ON "company_import_rows" USING btree ("source_system","kind","source_id");--> statement-breakpoint
CREATE INDEX "company_import_rows_batch_idx" ON "company_import_rows" USING btree ("batch_id","kind","state");--> statement-breakpoint
CREATE INDEX "company_import_rows_company_idx" ON "company_import_rows" USING btree ("company_source_id");--> statement-breakpoint
CREATE INDEX "company_import_rows_target_idx" ON "company_import_rows" USING btree ("target_id");
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on both tables.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "company_import_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_batches" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_batches" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_batches" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_batches" FROM service_role;--> statement-breakpoint
ALTER TABLE "company_import_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_rows" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_rows" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_rows" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_rows" FROM service_role;

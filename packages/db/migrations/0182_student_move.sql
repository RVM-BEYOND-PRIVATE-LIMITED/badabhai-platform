-- ==============================================================================
-- student_import_batches + student_import_rows + student_import_subjects + worker_field_sources
-- + student_visibility: moving RVM students into BadaBhai as workers (#2887)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2887 (ruling of Akshit and Prakash, 17 Nov 2026): RVM students move into BadaBhai in bulk as
-- ordinary workers, matched by BadaBhai's engine, shown to companies only when an admin turns
-- their visibility on; a profile the student edits on BadaBhai wins over the imported data.
--
--   - `student_import_batches`: one run of the import CLI (a full move or a `--since` sync).
--   - `student_import_rows`: what one run did to one Campus candidate (created, updated,
--     unchanged, held with a reason code, failed, rolled back). The run's report, and what
--     `--rollback` undoes. One row per candidate per run.
--   - `student_import_subjects`: the Campus candidate id -> the ONE worker he became (one phone is
--     one person: one candidate per worker), with the hash of his last exported record. This is
--     what makes a re-run idempotent.
--   - `worker_field_sources`: per worker and profile field, who wrote it last: the import or the
--     worker himself. A field the worker edited is never overwritten by a later sync.
--   - `student_visibility`: one row per moved student, `visible` false at import. While false he
--     is out of matching (`job_reach`) and #2752's rules keep him from companies; when an admin
--     turns it on he is an ordinary BadaBhai worker. A worker with no row was never moved.
--
-- ADDITIVE ONLY. Five new, EMPTY tables, their indexes and foreign keys; no existing column,
-- constraint or row moves. Nothing is seeded. No encrypted column: ids, closed codes, counts,
-- hashes and times only.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Every statement that names these
-- tables asks first whether `student_visibility` exists (`to_regclass`), so before this file the
-- reach statements, the company search pool, the open gate and the pre-pay facts read exactly as
-- before. The reach statements key on the table alone (reach depends on no switch, #2746 M2): once
-- it exists a hidden moved student is never reached; with no student imported there is no row and
-- nothing changes. Everything else waits for STUDENT_MOVE_ENABLED: off, the admin routes answer
-- 404 and a worker's own edit writes no field marker; on before this file, the routes answer 503
-- and the hot reads fall back to their switch-off form (logged once). Apply every
-- lower-numbered migration first (slot order), then this, then set the switch.
--
-- LOCKS. The five new tables are empty. The foreign keys to `workers` take a brief SHARE ROW
-- EXCLUSIVE lock on it (blocks its writes, not its reads, for the instant each constraint is
-- added; nothing to validate). Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 pattern) - a regenerate drops them
-- silently. All five tables are registered as `rls` entries in `schema-contract.ts` and listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch STUDENT_MOVE_ENABLED off and redeploy first; every import record, field marker
-- and visibility row is lost, and the moved workers stay as ordinary workers):
--   DROP TABLE "student_visibility";
--   DROP TABLE "worker_field_sources";
--   DROP TABLE "student_import_subjects";
--   DROP TABLE "student_import_rows";
--   DROP TABLE "student_import_batches";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "student_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"since" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	CONSTRAINT "student_import_batches_source_chk" CHECK ("student_import_batches"."source" IN ('campus')),
	CONSTRAINT "student_import_batches_status_chk" CHECK ("student_import_batches"."status" IN ('running', 'applied', 'failed', 'rolled_back')),
	CONSTRAINT "student_import_batches_label_chk" CHECK (char_length("student_import_batches"."label") BETWEEN 1 AND 120),
	CONSTRAINT "student_import_batches_counts_chk" CHECK (jsonb_typeof("student_import_batches"."counts") = 'object'),
	CONSTRAINT "student_import_batches_rolled_back_chk" CHECK (("student_import_batches"."status" = 'rolled_back') = ("student_import_batches"."rolled_back_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "student_import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "student_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"worker_id" uuid,
	"action" text NOT NULL,
	"reason" text,
	"worker_created" boolean DEFAULT false NOT NULL,
	"fields_written" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_import_rows_action_chk" CHECK ("student_import_rows"."action" IN ('created', 'updated', 'unchanged', 'held', 'failed', 'rolled_back')),
	CONSTRAINT "student_import_rows_source_id_chk" CHECK ("student_import_rows"."source_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "student_import_rows_reason_chk" CHECK ("student_import_rows"."reason" IS NULL OR "student_import_rows"."reason" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "student_import_rows_fields_chk" CHECK (jsonb_typeof("student_import_rows"."fields_written") = 'array')
);
--> statement-breakpoint
ALTER TABLE "student_import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "student_import_subjects" (
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"first_batch_id" uuid NOT NULL,
	"last_batch_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"first_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_import_subjects_pk" PRIMARY KEY("source","source_id"),
	CONSTRAINT "student_import_subjects_source_chk" CHECK ("student_import_subjects"."source" IN ('campus')),
	CONSTRAINT "student_import_subjects_source_id_chk" CHECK ("student_import_subjects"."source_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "student_import_subjects_hash_chk" CHECK ("student_import_subjects"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "student_import_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "student_visibility" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"visible" boolean DEFAULT false NOT NULL,
	"batch_id" uuid,
	"changed_by_admin_id" uuid,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_visibility_reason_chk" CHECK ("student_visibility"."reason" IS NULL OR char_length("student_visibility"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "student_visibility" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_field_sources" (
	"worker_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"source" text NOT NULL,
	"batch_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_field_sources_pk" PRIMARY KEY("worker_id","field_key"),
	CONSTRAINT "worker_field_sources_source_chk" CHECK ("worker_field_sources"."source" IN ('campus_import', 'worker')),
	CONSTRAINT "worker_field_sources_key_chk" CHECK ("worker_field_sources"."field_key" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "worker_field_sources_batch_chk" CHECK ("worker_field_sources"."source" = 'campus_import' OR "worker_field_sources"."batch_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "worker_field_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_import_rows" ADD CONSTRAINT "student_import_rows_batch_id_student_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."student_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_rows" ADD CONSTRAINT "student_import_rows_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_subjects" ADD CONSTRAINT "student_import_subjects_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_subjects" ADD CONSTRAINT "student_import_subjects_first_batch_id_student_import_batches_id_fk" FOREIGN KEY ("first_batch_id") REFERENCES "public"."student_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_subjects" ADD CONSTRAINT "student_import_subjects_last_batch_id_student_import_batches_id_fk" FOREIGN KEY ("last_batch_id") REFERENCES "public"."student_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_visibility" ADD CONSTRAINT "student_visibility_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_visibility" ADD CONSTRAINT "student_visibility_batch_id_student_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."student_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_field_sources" ADD CONSTRAINT "worker_field_sources_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_field_sources" ADD CONSTRAINT "worker_field_sources_batch_id_student_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."student_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_import_rows_batch_source_uq" ON "student_import_rows" USING btree ("batch_id","source_id");--> statement-breakpoint
CREATE INDEX "student_import_rows_worker_idx" ON "student_import_rows" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_import_subjects_worker_uq" ON "student_import_subjects" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "student_visibility_batch_idx" ON "student_visibility" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "student_visibility_hidden_idx" ON "student_visibility" USING btree ("worker_id") WHERE NOT "student_visibility"."visible";
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on all five tables.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "student_import_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_batches" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_batches" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_batches" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_batches" FROM service_role;--> statement-breakpoint
ALTER TABLE "student_import_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_rows" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_rows" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_rows" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_rows" FROM service_role;--> statement-breakpoint
ALTER TABLE "student_import_subjects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_subjects" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_subjects" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_subjects" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "student_import_subjects" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_field_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_field_sources" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_field_sources" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_field_sources" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_field_sources" FROM service_role;--> statement-breakpoint
ALTER TABLE "student_visibility" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "student_visibility" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "student_visibility" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "student_visibility" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "student_visibility" FROM service_role;

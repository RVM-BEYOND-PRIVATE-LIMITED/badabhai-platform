-- ===========================================================================
-- 0105 — RÉSUMÉ IMPORT: the document a worker uploaded, and what we read out of it
--
-- ADR-0041 (docs/decisions/0041-resume-import-and-prefill.md), phase RI-1.
--
-- !! THE JOURNAL `when` FOR THIS ENTRY IS PINNED. DO NOT REGENERATE BLINDLY. !!
--
-- `meta/_journal.json` carries when=1789115554493 for 0105. Running `drizzle-kit generate`
-- again stamps a NEW `when`, and because drizzle skips any entry whose `when` is below
-- MAX(created_at) in `__drizzle_migrations`, a re-stamped 0105 gets RE-RUN against a
-- database that already has this table: it dies on "relation already exists" and blocks
-- every later migration behind it. Silently, on the deploy.
--
-- THIS FILE WAS 0103 UNTIL 2026-09-11. It sat unmerged while 0103 and 0104 landed on main,
-- so it was renumbered on the rebase — and renumbering a migration means REGENERATING it,
-- because its snapshot has to carry 0104's state and not 0102's. Both hazards this header
-- already warned about duly happened on that regenerate: the `when` came back below 0104's
-- and the RLS block below was dropped. Both are restored by hand. If you renumber it again,
-- read the RLS section before you trust `drizzle-kit generate`'s output.
--
-- ONE NEW, EMPTY table. Nothing existing is touched: no column is added, removed, renamed
-- or re-typed on any shipped table, no constraint is relaxed, no index is rebuilt, no
-- policy is changed. Reversing it is a single table removal, after which the database is
-- byte-identical to 0104.
--
-- NOTE FOR WHOEVER APPLIES THIS: the feature stays inert afterwards. `RESUME_UPLOADS_BUCKET`
-- defaults to "" and every processing route 503s until it is set, so an applied 0105 on its
-- own changes nothing a worker can reach.
-- ===========================================================================
CREATE TABLE "worker_resume_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"byte_size" integer NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"extraction_method" text,
	"ocr_confidence" real,
	"page_count" integer,
	"route" text,
	"form_kind" text,
	"suggestions_enc" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wri_status_chk" CHECK ("worker_resume_import"."status" IN ('uploaded', 'parsing', 'parsed', 'failed', 'discarded')),
	CONSTRAINT "wri_extraction_method_chk" CHECK ("worker_resume_import"."extraction_method" IS NULL OR "worker_resume_import"."extraction_method" IN ('pdf_text', 'docx', 'ocr')),
	CONSTRAINT "wri_route_chk" CHECK ("worker_resume_import"."route" IS NULL OR "worker_resume_import"."route" IN ('form', 'chat')),
	CONSTRAINT "wri_byte_size_chk" CHECK ("worker_resume_import"."byte_size" > 0),
	CONSTRAINT "wri_storage_key_present_chk" CHECK (length(btrim("worker_resume_import"."storage_key")) > 0),
	CONSTRAINT "wri_page_count_chk" CHECK ("worker_resume_import"."page_count" IS NULL OR "worker_resume_import"."page_count" > 0),
	CONSTRAINT "wri_ocr_confidence_chk" CHECK (("worker_resume_import"."ocr_confidence" IS NULL AND "worker_resume_import"."extraction_method" IS DISTINCT FROM 'ocr') OR ("worker_resume_import"."extraction_method" = 'ocr' AND "worker_resume_import"."ocr_confidence" BETWEEN 0 AND 1)),
	CONSTRAINT "wri_form_kind_chk" CHECK (("worker_resume_import"."route" = 'form') = ("worker_resume_import"."form_kind" IS NOT NULL)),
	CONSTRAINT "wri_failure_reason_chk" CHECK (("worker_resume_import"."status" = 'failed') = ("worker_resume_import"."failure_reason" IS NOT NULL)),
	CONSTRAINT "wri_suggestions_chk" CHECK ("worker_resume_import"."suggestions_enc" IS NULL OR "worker_resume_import"."status" = 'parsed')
);
--> statement-breakpoint
ALTER TABLE "worker_resume_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "worker_resume_import_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wri_storage_key_uq" ON "worker_resume_import" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "wri_worker_recent_idx" ON "worker_resume_import" USING btree ("worker_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
-- ===========================================================================
-- RLS: FORCE + REVOKE — hand-written, exactly as they were for 0094 and 0098. Drizzle
-- emits only ENABLE, so a blind regenerate loses these silently, which is the second
-- reason this file is not to be regenerated blindly.
--
-- `worker_resume_import` holds an encrypted payload lifted from the worker's own document.
-- It is reached ONLY by the service role through `apps/api`; no Supabase client role has
-- any business selecting from it, so all four are revoked rather than policed.
-- ===========================================================================
ALTER TABLE "worker_resume_import" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_import" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_import" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_import" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_resume_import" FROM service_role;

-- ===========================================================================
-- 0156 — Candidate read table (`admin_candidate_index` + cursor) for #2557
-- (design: ADR-0062 §3.5 + §7).
--
-- WHAT. A derived read model, one row per worker, for the admin Candidates data
-- bank: every value is computed by `CandidateIndexProjector.projectWorker`
-- (apps/api) with the same TypeScript resolvers the employer-facing reads use.
-- `admin_candidate_index_cursor` is the single-row (`id = 'singleton'`)
-- watermark over `events.created_at` (the `learn_labels_cursor` precedent).
-- Both tables arrive EMPTY: the projector's poll tick + nightly rebuild + the
-- backfill CLI populate them after deploy. Nothing historical is projected here.
--
-- FULLY ADDITIVE AND REVERSIBLE: two new tables, no backfill in-migration, no
-- column/table touched. Rollback:
--   DROP TABLE IF EXISTS "admin_candidate_index_cursor";
--   DROP TABLE IF EXISTS "admin_candidate_index";
-- (the `pg_trgm` extension stays installed — migration 0067 owns it).
--
-- PRIVACY: folded canonical labels, opaque ids, closed-vocab labels, counts and
-- integer ₹ only. `search_doc` never holds a name/phone/employer/free text;
-- `name_token_hashes` are whole-word HMACs under the dedicated keyring;
-- `phone_hash` copies `workers.phone_hash`. No name, phone, employer name or
-- free text exists anywhere in this table.
--
-- DPDP: `worker_id` CASCADEs from `workers`, so the DSAR hard delete erases the
-- row with the same statement that erases everything else. No deletion change.
--
-- SPINE POSTURE: ENABLE (drizzle-emitted) + FORCE + four REVOKEs appended here,
-- matching every Matching V1 table — service-role connections only. Register in
-- `src/audit-schema-contract.ts` + `tests/e2e/rls-spine.e2e.test.ts`
-- LOCKED_TABLES.
--
-- DEPLOY ORDER: APPLY BEFORE DEPLOY. The projector upserts unconditionally, so
-- app code deployed against an unmigrated DB breaks the poll tick on every run.
SET lock_timeout = '3s';
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "admin_candidate_index" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"status" text,
	"flagged" boolean DEFAULT false NOT NULL,
	"is_test_account" boolean DEFAULT false NOT NULL,
	"deletion_scheduled_at" timestamp with time zone,
	"employer_sharing_consent" boolean DEFAULT false NOT NULL,
	"current_city" text,
	"current_state" text,
	"canonical_trade_id" text,
	"canonical_role_id" text,
	"job_domain_id" uuid,
	"trade_label" text,
	"role_label" text,
	"domain_label" text,
	"total_experience_years" numeric,
	"role_experience_months" integer,
	"salary_min_inr" numeric,
	"salary_max_inr" numeric,
	"salary_period" text,
	"availability_status" text,
	"shift_preference" text,
	"form_level" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"education_level" text,
	"resume_count" integer DEFAULT 0 NOT NULL,
	"latest_resume_status" text,
	"latest_resume_version" integer,
	"profile_status" text,
	"profile_source" text,
	"app_version" text,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ai_cost_inr" numeric(16, 6) DEFAULT '0' NOT NULL,
	"referral_source" text,
	"search_doc" text DEFAULT '' NOT NULL,
	"name_token_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"name_token_key_id" text,
	"phone_hash" text NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_candidate_index_resume_count_chk" CHECK ("admin_candidate_index"."resume_count" >= 0),
	CONSTRAINT "admin_candidate_index_salary_period_chk" CHECK ("admin_candidate_index"."salary_period" IS NULL OR "admin_candidate_index"."salary_period" IN ('month', 'day', 'year'))
);
--> statement-breakpoint
ALTER TABLE "admin_candidate_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_candidate_index_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_candidate_index_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_candidate_index" ADD CONSTRAINT "admin_candidate_index_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_candidate_index_phone_hash_uq" ON "admin_candidate_index" USING btree ("phone_hash");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_search_doc_trgm_idx" ON "admin_candidate_index" USING gin ("search_doc" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "admin_candidate_index_skills_gin_idx" ON "admin_candidate_index" USING gin ("skills");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_languages_gin_idx" ON "admin_candidate_index" USING gin ("languages");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_name_tokens_gin_idx" ON "admin_candidate_index" USING gin ("name_token_hashes");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_status_idx" ON "admin_candidate_index" USING btree ("status");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_trade_idx" ON "admin_candidate_index" USING btree ("canonical_trade_id");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_city_idx" ON "admin_candidate_index" USING btree ("current_city");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_last_active_idx" ON "admin_candidate_index" USING btree ("last_active_at");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_created_idx" ON "admin_candidate_index" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_candidate_index_name_key_idx" ON "admin_candidate_index" USING btree ("name_token_key_id");--> statement-breakpoint
ALTER TABLE "admin_candidate_index" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index" FROM anon;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index" FROM service_role;--> statement-breakpoint
ALTER TABLE "admin_candidate_index_cursor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index_cursor" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index_cursor" FROM anon;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index_cursor" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON "admin_candidate_index_cursor" FROM service_role;
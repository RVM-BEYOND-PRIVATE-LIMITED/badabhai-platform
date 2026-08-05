-- Generalized profiling — the JOB DOMAIN catalog.
--
-- Two NEW tables (`job_domain`, `job_domain_alias`) plus four NEW NULLABLE columns on
-- `worker_profiles`. EXPAND-ONLY: nothing is dropped, renamed, or made NOT NULL, and no
-- shipped column changes meaning. Nothing READS the new worker_profiles columns until
-- DOMAIN_MATCH_ENABLED is flipped on, so applying this is inert.
--
-- WHY: chat profiling no longer selects questions from a hardcoded question bank keyed
-- to 7 role families — an LLM conducts the interview for whatever trade the worker
-- actually does. That leaves one problem this catalog solves: at the end we must still
-- place the worker in a domain we support, and 13 hardcoded roles cannot express a
-- cook, a tailor, a driver or a warehouse picker. Seeded from published occupation
-- standards (ISCO-08 / NCO-2015) rather than invented in TypeScript.
--
-- ── A NOTE ON WHAT IS *NOT* IN THIS FILE ────────────────────────────────────────────
-- `pnpm db:generate` also emitted a DROP + re-ADD of "posting_boosts_tier_chk". It has
-- been REMOVED from this migration deliberately. Migration 0059 was hand-authored
-- without regenerating the drizzle snapshot, so `migrations/meta/` jumps 0058 -> 0060
-- and the generator diffed schema.ts against the STALE 0058 snapshot, re-emitting a
-- change 0059 already applied (journal idx 59 — every database has it). Replaying it
-- would take an ACCESS EXCLUSIVE lock on posting_boosts and revalidate every row to
-- arrive at the identical constraint. The 0060 snapshot committed alongside this file
-- records the widened CHECK correctly, so the chain is healed and a future
-- `db:generate` will not re-emit it.
--
-- ── LOCKS ───────────────────────────────────────────────────────────────────────────
-- CREATE TABLE takes no lock on anything live. The four ADD COLUMNs on worker_profiles
-- are NULLABLE WITH NO DEFAULT, so they are catalog-only metadata writes with no table
-- rewrite (Postgres 11+). The FK and CHECK added to worker_profiles DO take a brief
-- ACCESS EXCLUSIVE and scan the table; every existing row is NULL so both validate
-- trivially. At materially larger volume, split them:
--   ALTER TABLE "worker_profiles" ADD CONSTRAINT ... NOT VALID;
--   ALTER TABLE "worker_profiles" VALIDATE CONSTRAINT ...;   -- SHARE UPDATE EXCLUSIVE
-- The HNSW index is created on an EMPTY table, so it is instant; the ~thousands of rows
-- arrive later via `db:seed:domains` (embedding NULL, not indexed) and the
-- `db:embed:domains` backfill, so the index builds incrementally.
--
-- ── PII ─────────────────────────────────────────────────────────────────────────────
-- Both new tables are PII-FREE by construction: published occupation titles,
-- definitions, codes, and vectors over those titles. Nothing worker-derived is written
-- here. On worker_profiles the additions are a closed-vocabulary id, a status enum, a
-- float and a timestamp — no free text.
--
-- ── SAFE TO RE-RUN ──────────────────────────────────────────────────────────────────
-- No (plain CREATE TABLE / ADD COLUMN / ADD CONSTRAINT). Apply once; the journal is the
-- record.
--
-- ── ROLLBACK (fully reversible — nothing reads these) ───────────────────────────────
--   ALTER TABLE "worker_profiles" DROP CONSTRAINT IF EXISTS "worker_profiles_job_domain_match_status_chk";
--   ALTER TABLE "worker_profiles" DROP CONSTRAINT IF EXISTS "worker_profiles_job_domain_id_job_domain_job_domain_id_fk";
--   DROP INDEX IF EXISTS "worker_profiles_job_domain_id_idx";
--   ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "job_domain_matched_at";
--   ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "job_domain_match_score";
--   ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "job_domain_match_status";
--   ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "job_domain_id";
--   DROP TABLE IF EXISTS "job_domain_alias";
--   DROP TABLE IF EXISTS "job_domain";
-- Dropping the catalog loses only seeded reference data (`pnpm db:seed:domains --apply`
-- rebuilds it) and the alias embeddings (`pnpm db:embed:domains` re-earns them; the
-- whole corpus embeds for well under Rs 50).
--
-- Both new tables are registered in tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES —
-- that test asserts SET EQUALITY against the live public schema, so CI fails if a new
-- public table is not covered here.
CREATE TABLE "job_domain_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_domain_id" text NOT NULL,
	"text" text NOT NULL,
	"lang" text,
	"source" text NOT NULL,
	"embedding" vector(768),
	"embedding_model" text,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_domain_alias_source_chk" CHECK ("job_domain_alias"."source" IN ('isco08', 'nco2015', 'rvm'))
);
--> statement-breakpoint
ALTER TABLE "job_domain_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_domain" (
	"job_domain_id" text PRIMARY KEY NOT NULL,
	"label_en" text NOT NULL,
	"label_hi" text,
	"description_en" text,
	"source" text NOT NULL,
	"source_code" text,
	"level" smallint NOT NULL,
	"parent_job_domain_id" text,
	"isco_major_code" text,
	"isco_unit_code" text,
	"skill_level" smallint,
	"industry_id" text,
	"canonical_role_id" text,
	"selectable" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"replaced_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_domain_source_chk" CHECK ("job_domain"."source" IN ('isco08', 'nco2015', 'rvm')),
	CONSTRAINT "job_domain_status_chk" CHECK ("job_domain"."status" IN ('active', 'provisional', 'deprecated')),
	CONSTRAINT "job_domain_level_chk" CHECK ("job_domain"."level" BETWEEN 1 AND 5),
	CONSTRAINT "job_domain_skill_level_chk" CHECK ("job_domain"."skill_level" IS NULL OR "job_domain"."skill_level" BETWEEN 1 AND 4),
	CONSTRAINT "job_domain_selectable_leaf_chk" CHECK ("job_domain"."selectable" = false OR "job_domain"."level" >= 4),
	CONSTRAINT "job_domain_source_code_chk" CHECK ("job_domain"."source" = 'rvm' OR "job_domain"."source_code" IS NOT NULL),
	CONSTRAINT "job_domain_replaced_by_chk" CHECK ("job_domain"."replaced_by" IS NULL OR "job_domain"."status" = 'deprecated'),
	CONSTRAINT "job_domain_no_self_parent_chk" CHECK ("job_domain"."parent_job_domain_id" IS NULL OR "job_domain"."parent_job_domain_id" <> "job_domain"."job_domain_id")
);
--> statement-breakpoint
ALTER TABLE "job_domain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "job_domain_id" text;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "job_domain_match_status" text;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "job_domain_match_score" double precision;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "job_domain_matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_domain_alias" ADD CONSTRAINT "job_domain_alias_job_domain_id_job_domain_job_domain_id_fk" FOREIGN KEY ("job_domain_id") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_domain" ADD CONSTRAINT "job_domain_parent_job_domain_id_job_domain_job_domain_id_fk" FOREIGN KEY ("parent_job_domain_id") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_domain" ADD CONSTRAINT "job_domain_replaced_by_job_domain_job_domain_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_domain_alias_job_domain_id_idx" ON "job_domain_alias" USING btree ("job_domain_id");--> statement-breakpoint
CREATE INDEX "job_domain_alias_embedding_hnsw" ON "job_domain_alias" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "job_domain_source_code_uq" ON "job_domain" USING btree ("source","source_code");--> statement-breakpoint
CREATE INDEX "job_domain_parent_idx" ON "job_domain" USING btree ("parent_job_domain_id");--> statement-breakpoint
CREATE INDEX "job_domain_selectable_idx" ON "job_domain" USING btree ("selectable","status");--> statement-breakpoint
CREATE INDEX "job_domain_isco_unit_idx" ON "job_domain" USING btree ("isco_unit_code");--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_job_domain_id_job_domain_job_domain_id_fk" FOREIGN KEY ("job_domain_id") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_profiles_job_domain_id_idx" ON "worker_profiles" USING btree ("job_domain_id");--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_job_domain_match_status_chk" CHECK ("worker_profiles"."job_domain_match_status" IS NULL OR "worker_profiles"."job_domain_match_status" IN ('matched_auto', 'matched_llm', 'unmatched_below_floor', 'unmatched_llm_declined', 'unmatched_degraded'));--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20). drizzle-kit emits only ENABLE ROW LEVEL
-- SECURITY; FORCE + the REVOKEs are hand-appended, exactly as migrations
-- 0037/0048/0050/0052/0055/0057/0058 carry them. Both tables are registered in
-- tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "job_domain" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain" FROM service_role;--> statement-breakpoint
ALTER TABLE "job_domain_alias" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_alias" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_alias" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_alias" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_alias" FROM service_role;

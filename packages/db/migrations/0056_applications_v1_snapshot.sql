-- Matching V1 — step 5 of 7: the APPLICATIONS SNAPSHOT.
--
-- ⚠️ THE ONE-WAY DOOR OF THIS TRAIN. Everything else in 0052..0058 is a rebuildable
-- projection. This is not: the snapshot columns record what the rank inputs WERE at the
-- instant a worker applied, and a worker's skill months / industry months / recency all
-- move. History not captured on day one is gone permanently — it cannot be
-- reconstructed later from any other table. Ship this BEFORE the first V1 application,
-- not after.
--
-- EXPAND-ONLY in the structural sense — nothing is dropped, renamed, or tightened:
--   * `job_id` DROP NOT NULL is a RELAXATION. Every existing row still satisfies it;
--     every existing reader still sees a non-null job_id on every existing row.
--   * `job_posting_id` + the 5 snapshot columns are all NULLABLE ADD COLUMNs
--     (catalog-only on PG11+, no rewrite).
--   * `applications_job_ref_chk` guarantees at least one job reference is always
--     present, so a row can never lose its subject.
--
-- COEXIST — NEVER REPOINT. Existing alpha applications keep `job_id` pointing at their
-- now-closed `jobs` row, forever. NOTHING in this migration or in D1..D6 rewrites them.
-- Every NEW decision writes `job_posting_id`. Repointing history would silently rewrite
-- what a worker actually applied to.
--
-- 🔒 THE IRREVERSIBLE PART, stated plainly for the applier:
--   Re-adding `NOT NULL` to `applications.job_id` is possible ONLY while zero rows have
--   `job_id IS NULL`. The moment the first V1 application is written, that door is shut
--   — undoing it would mean DELETING real worker applications. Everything else in this
--   migration (the columns, the indexes, the checks) drops cleanly at any time.
--   Verify before rolling back:
--     SELECT count(*) FROM applications WHERE job_id IS NULL;   -- must be 0
--
-- NEW COLUMNS: job_posting_id, match_tier, skill_months, industry_months,
--   last_worked_at, engine_version.
-- NEW INDEXES: applications_worker_posting_uq (PARTIAL unique — E15, one application per
--   worker+posting); applications_applied_posting_idx (the feed's applied-exclusion);
--   applications_rank_idx (the payer's applicant list in exact rank order, `id` last so
--   the order is TOTAL and keyset pagination cannot skip or repeat).
-- NEW CHECKS: job_ref (at least one pointer), match_tier ∈ (1,2), months non-negative.
--
-- The shipped `applications_worker_job_uq` is UNTOUCHED and keeps working: Postgres
-- treats NULLs as DISTINCT, so posting-only rows never collide in it.
--
-- LOCKS: DROP NOT NULL and the ADD COLUMNs are catalog-only (instant). The three CREATE
-- INDEX and three ADD CONSTRAINT statements take a strong lock on `applications` and
-- scan it. Small today. On a large table use CREATE INDEX CONCURRENTLY out of band and
-- ADD CONSTRAINT ... NOT VALID + VALIDATE CONSTRAINT instead.
--
-- ROLLBACK (structural — safe ONLY while `job_id IS NULL` count is 0, see above):
--   DROP INDEX IF EXISTS "applications_rank_idx";
--   DROP INDEX IF EXISTS "applications_applied_posting_idx";
--   DROP INDEX IF EXISTS "applications_worker_posting_uq";
--   ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_snapshot_months_nonneg_chk";
--   ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_match_tier_chk";
--   ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_job_ref_chk";
--   ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_job_posting_id_job_postings_id_fk";
--   ALTER TABLE "applications" DROP COLUMN IF EXISTS "engine_version";
--   ALTER TABLE "applications" DROP COLUMN IF EXISTS "last_worked_at";
--   ALTER TABLE "applications" DROP COLUMN IF EXISTS "industry_months";
--   ALTER TABLE "applications" DROP COLUMN IF EXISTS "skill_months";
--   ALTER TABLE "applications" DROP COLUMN IF EXISTS "match_tier";
--   ALTER TABLE "applications" DROP COLUMN IF EXISTS "job_posting_id";
--   ALTER TABLE "applications" ALTER COLUMN "job_id" SET NOT NULL;   -- ONLY if 0 nulls
ALTER TABLE "applications" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "job_posting_id" uuid;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "match_tier" smallint;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "skill_months" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "industry_months" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "last_worked_at" date;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "engine_version" text;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_worker_posting_uq" ON "applications" USING btree ("worker_id","job_posting_id") WHERE "applications"."job_posting_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "applications_applied_posting_idx" ON "applications" USING btree ("worker_id","job_posting_id") WHERE "applications"."action" = 'applied' AND "applications"."job_posting_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "applications_rank_idx" ON "applications" USING btree ("job_posting_id","match_tier","skill_months" DESC NULLS LAST,"industry_months" DESC NULLS LAST,"last_worked_at" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id") WHERE "applications"."action" = 'applied';--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_ref_chk" CHECK (("applications"."job_id" IS NOT NULL) OR ("applications"."job_posting_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_match_tier_chk" CHECK ("applications"."match_tier" IS NULL OR "applications"."match_tier" IN (1, 2));--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_snapshot_months_nonneg_chk" CHECK (("applications"."skill_months" IS NULL OR "applications"."skill_months" >= 0) AND ("applications"."industry_months" IS NULL OR "applications"."industry_months" >= 0));
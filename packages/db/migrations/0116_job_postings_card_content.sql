-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 0116 — job_postings card content: area / experience window / benefits / requirements (#1561)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- The CEO read of the Jobs deck: the card showed title/place/pay only, the rest empty — a
-- backend contract gap, not a seed-content gap. The 17-row `jobs` seed carries full detail
-- (area, experience window, description, benefits, requirements), but the served entity
-- (`job_postings`, since the 0054 cutover) has no columns for area, experience, benefits or
-- requirements, so the V1 feed/search/detail projections honestly returned NULL and
-- `db:convert:seed-jobs` could not carry the content across.
--
--   area                   COARSE locality bucket (e.g. "Chakan"), mirrors `jobs.area`.
--                          NEVER an address, and NEVER derived from `location_label`.
--   min/max_experience_years  experience window (years), mirrors `jobs`.
--   benefits / requirements   short PII-free strings/tags, mirrors `jobs`.
--
-- PRIVACY: same contract as the neighbouring columns — coarse buckets, year counts and
-- short generic strings. No employer identity, ever (ADR-0009 §2).
--
-- ADDITIVE / BACKWARD-COMPATIBLE. Five nullable columns, no default, no backfill, plus the
-- two experience CHECKs `jobs` already has (mirrored verbatim); old builds never name them.
-- New readers treat NULL as honest absence (the client hides the row). Reversible:
--
--   ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_experience_order_chk";
--   ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_experience_nonneg_chk";
--   ALTER TABLE "job_postings" DROP COLUMN "requirements";
--   ALTER TABLE "job_postings" DROP COLUMN "benefits";
--   ALTER TABLE "job_postings" DROP COLUMN "max_experience_years";
--   ALTER TABLE "job_postings" DROP COLUMN "min_experience_years";
--   ALTER TABLE "job_postings" DROP COLUMN "area";
--
-- APPLY-BEFORE-DEPLOY: the feed/search/detail selects name these columns unconditionally,
-- so a build carrying them against a database without them 500s every job read.
-- Registered as `0116-job-postings-card-columns` in `schema-contract.ts`; run
-- `pnpm --filter @badabhai/db db:audit:schema-contract` first.
--
-- Lock: nullable `ADD COLUMN` is catalog-only and each `ADD CONSTRAINT` over an all-NULL
-- column validates nothing, so under `SET lock_timeout = '3s';` and retry on 55P03 the
-- ACCESS EXCLUSIVE window is sub-second (0109 precedent).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE "job_postings" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "min_experience_years" integer;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "max_experience_years" integer;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "benefits" jsonb;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "requirements" jsonb;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_experience_nonneg_chk" CHECK (("job_postings"."min_experience_years" IS NULL OR "job_postings"."min_experience_years" >= 0) AND ("job_postings"."max_experience_years" IS NULL OR "job_postings"."max_experience_years" >= 0));--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_experience_order_chk" CHECK ("job_postings"."min_experience_years" IS NULL OR "job_postings"."max_experience_years" IS NULL OR "job_postings"."max_experience_years" >= "job_postings"."min_experience_years");

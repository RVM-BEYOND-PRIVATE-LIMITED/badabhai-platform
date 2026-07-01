-- =====================================================================================
-- 0034 — ADR-0027 B5.x Increment 0: additive org_id on the 9 payer-owned tables.
--
-- ADDITIVE FOUNDATION of the payer_id -> org_id chokepoint flip. This migration ONLY:
--   1. adds a NULLABLE org_id uuid + org-scoped index(es) to each of the 9 tables,
--   2. backfills org_id from payer_orgs.id WHERE root_payer_id = payer_id,
--   3. tightens org_id to NOT NULL on the 7 tables whose payer_id is NOT NULL, and
--      adds a partial CHECK (payer_id IS NULL OR org_id IS NOT NULL) on the 2 tables
--      whose payer_id is NULLABLE (job_postings, jobs — ops/seed rows keep both NULL).
--
-- It does NOT flip a single read/write predicate, does NOT drop or rename any existing
-- column or index, and does NOT touch any repo/service/controller. Every existing
-- payer_id column + index stays; the new org_id indexes are ADDITIVE alongside them.
-- Behaviorally INERT: no live query reads org_id yet (the flip is a later B5.x increment). PII-free
-- (org_id / payer_id are opaque uuids). Idempotent (IF NOT EXISTS + IS NULL backfill)
-- so a partial re-run is safe.
--
-- ROLLBACK (app is bit-for-bit unaffected — payer_id and every old predicate untouched):
--   ALTER TABLE unlocks             DROP CONSTRAINT IF EXISTS unlocks_org_id_when_payer_chk; -- (none; NOT NULL instead)
--   ALTER TABLE job_postings        DROP CONSTRAINT IF EXISTS job_postings_org_id_when_payer_chk;
--   ALTER TABLE jobs                DROP CONSTRAINT IF EXISTS jobs_org_id_when_payer_chk;
--   DROP INDEX IF EXISTS unlocks_org_worker_uq, unlocks_org_id_idx,
--     payer_credits_org_id_uq, credit_ledger_org_id_idx, posting_plans_org_id_idx,
--     posting_boosts_org_id_idx, payer_capacity_org_id_uq,
--     resume_disclosures_org_worker_posting_uq, resume_disclosures_org_id_idx,
--     job_postings_org_id_idx, jobs_org_id_idx;
--   ALTER TABLE <each of the 9> DROP COLUMN IF EXISTS org_id;
-- (Dropping the column also drops its NOT NULL / CHECK / index, so the DROP COLUMN
-- lines alone fully reverse this migration.)
-- =====================================================================================

-- ── 1. Columns (NULLABLE first, so the backfill can populate them) ───────────────────
ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "payer_capacity" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "payer_credits" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "posting_boosts" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "posting_plans" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "unlocks" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint

-- ── 2. Backfill: org_id = the solo org for this payer (payer_orgs.root_payer_id = payer_id).
--     Only rows still NULL are touched (idempotent). Rows with NULL payer_id (ops/seed
--     job_postings + jobs) match nothing and legitimately stay org_id NULL. ─────────────
UPDATE "credit_ledger"      AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "job_postings"       AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "jobs"               AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "payer_capacity"     AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "payer_credits"      AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "posting_boosts"     AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "posting_plans"      AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "resume_disclosures" AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "unlocks"            AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint

-- ── 3a. NOT NULL for the 7 tables whose payer_id is NOT NULL (every row is now backfilled).
ALTER TABLE "unlocks" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_credits" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posting_plans" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posting_boosts" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_capacity" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- ── 3b. Partial CHECK for the 2 tables whose payer_id is NULLABLE (ops/seed rows have NULL
--     payer_id and legitimately stay org_id NULL). A payer-owned row (payer_id NOT NULL)
--     MUST be org-scoped. Guarded so a re-run does not error on the duplicate constraint.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_postings_org_id_when_payer_chk') THEN
    ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_org_id_when_payer_chk" CHECK ("payer_id" IS NULL OR "org_id" IS NOT NULL);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_org_id_when_payer_chk') THEN
    ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_when_payer_chk" CHECK ("payer_id" IS NULL OR "org_id" IS NOT NULL);
  END IF;
END $$;--> statement-breakpoint

-- ── 4. Indexes (ADDITIVE — every existing payer_id index stays). Created AFTER the backfill
--     so the unique ones are built on populated data. ───────────────────────────────────
CREATE INDEX IF NOT EXISTS "credit_ledger_org_id_idx" ON "credit_ledger" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_postings_org_id_idx" ON "job_postings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_org_id_idx" ON "jobs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payer_capacity_org_id_uq" ON "payer_capacity" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payer_credits_org_id_uq" ON "payer_credits" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posting_boosts_org_id_idx" ON "posting_boosts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posting_plans_org_id_idx" ON "posting_plans" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resume_disclosures_org_worker_posting_uq" ON "resume_disclosures" USING btree ("org_id","worker_id","job_posting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_disclosures_org_id_idx" ON "resume_disclosures" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unlocks_org_worker_uq" ON "unlocks" USING btree ("org_id","worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unlocks_org_id_idx" ON "unlocks" USING btree ("org_id");

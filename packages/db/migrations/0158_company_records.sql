-- ==============================================================================
-- 0158 - company records: archive-ready statuses + company profile/search columns (#2564 B10)
-- ==============================================================================
--
-- Additive only: one nullable array column + GIN index, ten nullable profile
-- columns, and two widened CHECKs. No data backfill in SQL (word hashes are filled
-- by `db:backfill:company-name-words` over the event spine + live names).
--   * payers.org_name_word_hashes - one keyed-HMAC digest per word of the org name
--     (`company-search.companyNameWordHashes`), for whole-word company search WITHOUT
--     decrypting names. NULL = pre-column row.
--   * employer_profiles.gst_number_hash / .city / .address_enc / .contact_name_enc
--     and the six agency_profiles columns - the company record: exact GST lookup,
--     coarse city bucket, ciphertext GST/address/contact person.
--   * job_postings_status_chk + job_postings_previous_status_chk - widened ADDITIVELY
--     with 'archived' (the company-archive freeze, twin of 'suspended'). A narrowing
--     would have failed on archived rows; this direction cannot fail on existing ones.
--
-- APPLY-BEFORE-DEPLOY. Manual apply BEFORE the build that reads these columns deploys
-- (code auto-deploys on merge; migrations never do). The company writers name every
-- new column explicitly and the archive cascade writes status='archived' — so the new
-- build against an unmigrated database 500s company create/edit/archive/restore and
-- the org list. The OLD build on a migrated database is fine (a superset).
-- Registered as `0158-company-records` in `schema-contract.ts`.
--
-- LOCKS. Nullable ADD COLUMNs are catalog-only (PG11+ fast default) but still take a
-- brief ACCESS EXCLUSIVE on `payers` / `agency_profiles` / `employer_profiles` — take
-- it with a short timeout and retry on 55P03. The CHECK swap (DROP + ADD) takes
-- ACCESS EXCLUSIVE on `job_postings` and revalidates every row (full scan, all rows
-- satisfy the wider CHECK by construction) — same lock discipline as the 0059 boost
-- widening. CREATE INDEX (GIN) takes SHARE locks; CONCURRENTLY is not used because
-- the migration runs in one transaction (drizzle journal semantics).
--
-- ROLLBACK: drop the added columns + index and restore the two CHECKs, then delete
-- the journal row —
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_previous_status_chk";
--   ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_status_chk";
--   DROP INDEX "payers_org_word_hashes_gin_idx";
--   ALTER TABLE "employer_profiles" DROP COLUMN IF EXISTS "contact_name_enc";
--   ALTER TABLE "employer_profiles" DROP COLUMN IF EXISTS "address_enc";
--   ALTER TABLE "employer_profiles" DROP COLUMN IF EXISTS "city";
--   ALTER TABLE "employer_profiles" DROP COLUMN IF EXISTS "gst_number_hash";
--   ALTER TABLE "agency_profiles" DROP COLUMN IF EXISTS "contact_name_enc";
--   ALTER TABLE "agency_profiles" DROP COLUMN IF EXISTS "address_enc";
--   ALTER TABLE "agency_profiles" DROP COLUMN IF EXISTS "city";
--   ALTER TABLE "agency_profiles" DROP COLUMN IF EXISTS "website";
--   ALTER TABLE "agency_profiles" DROP COLUMN IF EXISTS "gst_number_hash";
--   ALTER TABLE "agency_profiles" DROP COLUMN IF EXISTS "gst_number_enc";
--   ALTER TABLE "payers" DROP COLUMN IF EXISTS "org_name_word_hashes";
--   ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_status_chk" CHECK ("job_postings"."status" IN ('draft', 'open', 'paused', 'suspended', 'closed'));
--   ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_previous_status_chk" CHECK (("job_postings"."status" = 'suspended') OR ("job_postings"."previous_status" IS NULL));
--   DELETE FROM drizzle.__drizzle_migrations WHERE ... (this entry's journal `when`);
--   COMMIT;
-- only AFTER rolling the API back to a build that does not name them. Dropping them
-- loses the word-hash search index (list search falls back to nothing), the company
-- profile fields, and the 'archived' vocabulary (archived rows fail the narrowed
-- CHECK — restore every archived company BEFORE rolling back).
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_status_chk";--> statement-breakpoint
ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_previous_status_chk";--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "org_name_word_hashes" text[];--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "gst_number_enc" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "gst_number_hash" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "address_enc" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "contact_name_enc" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "gst_number_hash" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "address_enc" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "contact_name_enc" text;--> statement-breakpoint
CREATE INDEX "payers_org_word_hashes_gin_idx" ON "payers" USING gin ("org_name_word_hashes");--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_status_chk" CHECK ("job_postings"."status" IN ('draft', 'open', 'paused', 'suspended', 'archived', 'closed'));--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_previous_status_chk" CHECK (("job_postings"."status" IN ('suspended', 'archived')) OR ("job_postings"."previous_status" IS NULL));

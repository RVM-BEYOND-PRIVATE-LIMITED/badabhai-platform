-- ==============================================================================
-- 0159 - company records: archive status, profile contact fields, name + GST search (#2564 B10)
-- ==============================================================================
--
-- Additive. No column is altered or dropped and no data is rewritten.
--   * payers.org_name_token_hashes text[] NOT NULL DEFAULT '{}' + org_name_token_key_id text
--       Whole-word company-name search tokens (keyed HMAC per folded word, `company:` domain,
--       ADR-0062 §3.6 keys). '{}' on every existing row = not yet tokenised; the
--       `db:backfill:company-name-tokens` CLI fills them once the keys are set. Never the name.
--   * employer_profiles + agency_profiles: address_enc, company_phone_enc, company_email_enc,
--       contact_person_enc (AES ciphertext, B2B PII) and gst_number_hash (keyed HMAC, `gstin:`
--       domain). agency_profiles also gains gst_number_enc and website (employer_profiles had
--       both). Owner ruling D4: these tables ARE the company record. Both hold 0 rows today.
--   * payers_status_chk - the payer lifecycle pinned for the FIRST time, with the new
--       'archived' value: ('pending','active','suspended','archived'). There was no CHECK on
--       payers.status before this (PAY-DB-08), so the DROP IF EXISTS is a no-op on every
--       migrated database; it is there so a hand-applied CHECK of the same name cannot block it.
--
-- PREFLIGHT (production, before applying). The new CHECK validates every existing row, so any
-- status outside the four would fail the migration (atomically, nothing applied):
--   SELECT status, count(*) FROM payers GROUP BY status;
-- Expected: only pending / active / suspended.
--
-- APPLY-BEFORE-DEPLOY. Manual apply BEFORE the build that reads these columns deploys (code
-- auto-deploys on merge; migrations never do). `PayersRepository`'s bare `select()` /
-- `.returning()` name every model column on every payer auth request, so the new build on an
-- unmigrated database 500s payer sign-in and every guarded /payer route. The OLD build on a
-- migrated database is fine (a superset; it never writes 'archived'). Registered as
-- `0159-payers-org-name-tokens`, `0159-payers-status-chk` and `0159-employer-profiles-contact`
-- in `schema-contract.ts`.
--
-- LOCKS. The ADD COLUMNs are catalog-only (PG11+ fast default) but take a brief ACCESS EXCLUSIVE
-- on `payers` - read on EVERY payer request - hence the short lock_timeout; retry on 55P03.
-- The GIN + two btree CREATE INDEXes are non-CONCURRENT (drizzle runs in a transaction): on
-- `payers` that holds a SHARE lock for a build over every row's empty array, milliseconds at
-- today's size; the profile tables are empty. The CHECK scans `payers` under its lock.
--
-- ROLLBACK, only AFTER rolling the API back to a build that does not name these columns, and
-- only after restoring every archived company (rows in 'archived' violate nothing once the
-- CHECK is gone, but an old build cannot restore them):
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "payers" DROP CONSTRAINT IF EXISTS "payers_status_chk";
--   DROP INDEX IF EXISTS "payers_org_name_tokens_gin_idx";
--   DROP INDEX IF EXISTS "employer_profiles_gst_number_hash_idx";
--   DROP INDEX IF EXISTS "agency_profiles_gst_number_hash_idx";
--   ALTER TABLE "payers" DROP COLUMN IF EXISTS "org_name_token_key_id", DROP COLUMN IF EXISTS "org_name_token_hashes";
--   ALTER TABLE "employer_profiles" DROP COLUMN IF EXISTS "gst_number_hash", DROP COLUMN IF EXISTS "contact_person_enc",
--     DROP COLUMN IF EXISTS "company_email_enc", DROP COLUMN IF EXISTS "company_phone_enc", DROP COLUMN IF EXISTS "address_enc";
--   ALTER TABLE "agency_profiles" DROP COLUMN IF EXISTS "website", DROP COLUMN IF EXISTS "gst_number_hash",
--     DROP COLUMN IF EXISTS "gst_number_enc", DROP COLUMN IF EXISTS "contact_person_enc", DROP COLUMN IF EXISTS "company_email_enc",
--     DROP COLUMN IF EXISTS "company_phone_enc", DROP COLUMN IF EXISTS "address_enc";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793952483323;
--   COMMIT;
-- Dropping the profile columns loses every saved company contact field and GSTIN; the
-- audit_logs reasons and payer.company_updated events (changed KEYS only) survive.
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "org_name_token_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "org_name_token_key_id" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "address_enc" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "company_phone_enc" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "company_email_enc" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "contact_person_enc" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "gst_number_enc" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "gst_number_hash" text;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "address_enc" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "company_phone_enc" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "company_email_enc" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "contact_person_enc" text;--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD COLUMN "gst_number_hash" text;--> statement-breakpoint
CREATE INDEX "payers_org_name_tokens_gin_idx" ON "payers" USING gin ("org_name_token_hashes");--> statement-breakpoint
CREATE INDEX "agency_profiles_gst_number_hash_idx" ON "agency_profiles" USING btree ("gst_number_hash");--> statement-breakpoint
CREATE INDEX "employer_profiles_gst_number_hash_idx" ON "employer_profiles" USING btree ("gst_number_hash");--> statement-breakpoint
ALTER TABLE "payers" DROP CONSTRAINT IF EXISTS "payers_status_chk";--> statement-breakpoint
ALTER TABLE "payers" ADD CONSTRAINT "payers_status_chk" CHECK ("payers"."status" IN ('pending', 'active', 'suspended', 'archived'));
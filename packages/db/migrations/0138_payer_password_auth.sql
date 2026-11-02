-- ==============================================================================
-- 0138 - payer password auth (issue #2497)
-- ==============================================================================
--
-- Additive only: new nullable columns/indexes, and four NOT NULL relaxations
-- (payers.email_* for phone-only signup; payer_members.email_* for phone-only
-- founder owner rows — email invites still always carry an email). No CHECK, no
-- UNIQUE changes (duplicate org names and historical duplicate phones are
-- legitimate), old columns untouched. Existing rows get NULLs (never stated).
--
-- org_name_lookup_hash is filled lazily by the API on the next successful login
-- (decrypt org name -> keyed HMAC -> store) — no backfill ships here because the
-- HMAC key lives server-side, never in SQL.
--
-- Manual apply by Divyanshu BEFORE the build that reads these columns deploys
-- (code auto-deploys on merge; migrations never do). The new reads are additive
-- and NULL-tolerant, so the migration is safe to apply ahead of the code.
-- ROLLBACK: drop the added columns/indexes; re-ADD the NOT NULL constraints only
-- if no NULL email rows were created in the meantime (else backfill first).
SET lock_timeout='3s';--> statement-breakpoint
ALTER TABLE "payer_members" ALTER COLUMN "email_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_members" ALTER COLUMN "email_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ALTER COLUMN "email_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ALTER COLUMN "email_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "org_name_lookup_hash" text;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "password_pepper_version" integer;--> statement-breakpoint
CREATE INDEX "payers_org_lookup_hash_idx" ON "payers" USING btree ("org_name_lookup_hash");--> statement-breakpoint
CREATE INDEX "payers_phone_hash_idx" ON "payers" USING btree ("phone_hash");
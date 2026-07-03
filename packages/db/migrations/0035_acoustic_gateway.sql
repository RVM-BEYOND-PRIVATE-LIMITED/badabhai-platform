-- =====================================================================================
-- 0035 — ADR-0027 B5.1 + B5.x Increment 0 (RENUMBERED from the pre-merge 0033/0034).
--
-- Reconciled during `git merge origin/main`: origin/main took the 0033/0034 slots
-- (0033_volatile_venom = job_postings 'paused' state, #178; 0034_sturdy_vindicator =
-- posting_plans.quota_topup_count, #180). This migration carries the b5x org work that
-- previously lived in 0033_dark_crusher_hogan (payer_orgs + payer_members + solo-org
-- backfill) and 0034_wonderful_nico_minoru (additive org_id on the 9 payer-owned tables
-- + backfill + NOT NULL + partial CHECKs + org-scoped indexes), now chained onto main's
-- 0034_sturdy_vindicator state. The DDL is drizzle-generated from the merged schema.ts;
-- the DATA backfills, SET NOT NULL, and the two partial CHECKs are hand-carried verbatim
-- (drizzle emits DDL only and cannot regenerate them).
--
-- WHAT THIS DOES (all ADDITIVE + behaviorally INERT — no live query reads org_id yet;
-- the payer_id -> org_id chokepoint flip is a later B5.x increment):
--   1. CREATE payer_orgs (tenant root) + payer_members (membership) + their FKs/indexes.
--   2. Solo-org backfill: each existing payer becomes a SOLO org whose single already-
--      accepted OWNER member mirrors the payer's own login email (encrypted + keyed hash).
--   3. ADD nullable org_id to the 9 payer-owned tables, backfill org_id from
--      payer_orgs.id WHERE root_payer_id = payer_id.
--   4. SET NOT NULL on the 7 tables whose payer_id is NOT NULL (every row is now
--      backfilled); add a partial CHECK (payer_id IS NULL OR org_id IS NOT NULL) on the 2
--      tables whose payer_id is NULLABLE (job_postings, jobs — ops/seed rows keep both NULL).
--   5. org-scoped (unique) indexes, created AFTER the backfill so the unique ones build on
--      populated data. Postgres unique-index NULLs are distinct, so the org_id unique
--      indexes remain NULLS-DISTINCT alongside the still-present payer_id indexes.
--
-- PII-free (org_id / payer_id are opaque uuids; email is encrypted at rest + keyed hash,
-- TD21). Idempotent (ON CONFLICT DO NOTHING + IS NULL backfill) so a partial re-run is safe.
--
-- ROLLBACK (app is bit-for-bit unaffected — payer_id and every old predicate untouched):
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_org_id_when_payer_chk";
--   ALTER TABLE "jobs"         DROP CONSTRAINT IF EXISTS "jobs_org_id_when_payer_chk";
--   DROP INDEX IF EXISTS "unlocks_org_worker_uq", "unlocks_org_id_idx",
--     "payer_credits_org_id_uq", "credit_ledger_org_id_idx", "posting_plans_org_id_idx",
--     "posting_boosts_org_id_idx", "payer_capacity_org_id_uq",
--     "resume_disclosures_org_worker_posting_uq", "resume_disclosures_org_id_idx",
--     "job_postings_org_id_idx", "jobs_org_id_idx";
--   ALTER TABLE <each of the 9> DROP COLUMN IF EXISTS "org_id";
--     (Dropping the column also drops its NOT NULL / CHECK / org_id index.)
--   DROP TABLE IF EXISTS "payer_members"; DROP TABLE IF EXISTS "payer_orgs";
-- =====================================================================================

-- ── 1. Tenant tables ──────────────────────────────────────────────────────────────────
CREATE TABLE "payer_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"member_payer_id" uuid,
	"email_enc" text NOT NULL,
	"email_hash" text NOT NULL,
	"org_role" text DEFAULT 'recruiter' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" uuid,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_members_role_chk" CHECK ("payer_members"."org_role" IN ('owner', 'recruiter')),
	CONSTRAINT "payer_members_status_chk" CHECK ("payer_members"."status" IN ('invited', 'active', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "payer_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payer_orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_payer_id" uuid NOT NULL,
	"name_enc" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_orgs_status_chk" CHECK ("payer_orgs"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "payer_orgs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_members" ADD CONSTRAINT "payer_members_org_id_payer_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."payer_orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_members" ADD CONSTRAINT "payer_members_member_payer_id_payers_id_fk" FOREIGN KEY ("member_payer_id") REFERENCES "public"."payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_members" ADD CONSTRAINT "payer_members_invited_by_payers_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_orgs" ADD CONSTRAINT "payer_orgs_root_payer_id_payers_id_fk" FOREIGN KEY ("root_payer_id") REFERENCES "public"."payers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── 2. Solo-org backfill (ADR-0027 B5.1, carried verbatim from 0033_dark_crusher_hogan).
-- Each existing payer becomes a SOLO org (root_payer_id = the payer), carrying the payer's
-- B2B org display name (ciphertext). Idempotent via the unique root_payer_id, so a re-run
-- is a no-op. Additive — no existing row is modified. Must precede the payer_members insert
-- (which references payer_orgs) and the org_id backfill in step 3.
INSERT INTO "payer_orgs" ("root_payer_id", "name_enc", "status")
SELECT "id", "org_name_enc", 'active' FROM "payers"
ON CONFLICT ("root_payer_id") DO NOTHING;--> statement-breakpoint
-- Each solo org gets its founding payer as the single already-accepted OWNER member. The
-- member email mirrors the payer's own login email (encrypted at rest + keyed hash; TD21).
-- Idempotent via the unique (org_id, email_hash). The unique indexes below build on this data.
INSERT INTO "payer_members" ("org_id", "member_payer_id", "email_enc", "email_hash", "org_role", "status", "invited_at", "accepted_at")
SELECT o."id", p."id", p."email_enc", p."email_hash", 'owner', 'active', now(), now()
FROM "payer_orgs" o JOIN "payers" p ON p."id" = o."root_payer_id"
ON CONFLICT ("org_id", "email_hash") DO NOTHING;--> statement-breakpoint

-- ── 3. org_id on the 9 payer-owned tables (NULLABLE first, so the backfill can populate).
-- (Carried from 0034_wonderful_nico_minoru.) ──────────────────────────────────────────
ALTER TABLE "credit_ledger" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "payer_capacity" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "payer_credits" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "posting_boosts" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "posting_plans" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "unlocks" ADD COLUMN "org_id" uuid;--> statement-breakpoint

-- ── 3b. Backfill: org_id = the solo org for this payer (payer_orgs.root_payer_id = payer_id).
-- Only rows still NULL are touched (idempotent). Rows with NULL payer_id (ops/seed
-- job_postings + jobs) match nothing and legitimately stay org_id NULL. Must precede the
-- SET NOT NULL / unique indexes below.
UPDATE "credit_ledger"      AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "job_postings"       AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "jobs"               AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "payer_capacity"     AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "payer_credits"      AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "posting_boosts"     AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "posting_plans"      AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "resume_disclosures" AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "unlocks"            AS t SET "org_id" = po."id" FROM "payer_orgs" po WHERE po."root_payer_id" = t."payer_id" AND t."org_id" IS NULL;--> statement-breakpoint

-- ── 4a. NOT NULL for the 7 tables whose payer_id is NOT NULL (every row is now backfilled).
-- (Carried from 0034_wonderful_nico_minoru. schema.ts intentionally models org_id NULLABLE
-- here — the tightening is DB-only, so a future db:generate diff stays clean.)
ALTER TABLE "unlocks" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_credits" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posting_plans" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posting_boosts" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_capacity" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- ── 4b. Partial CHECK for the 2 tables whose payer_id is NULLABLE (ops/seed rows have NULL
-- payer_id and legitimately stay org_id NULL). A payer-owned row (payer_id NOT NULL) MUST
-- be org-scoped. Guarded so a re-run does not error on the duplicate constraint. (These are
-- NOT modeled in schema.ts — carried verbatim from 0034_wonderful_nico_minoru.)
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

-- ── 5. Indexes (ADDITIVE — every existing payer_id index stays). Created AFTER the backfill
-- so the unique ones build on populated data. Unique-index NULLs stay distinct (NULLS-DISTINCT).
CREATE INDEX "payer_members_org_id_idx" ON "payer_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payer_members_member_payer_id_idx" ON "payer_members" USING btree ("member_payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_members_org_email_uq" ON "payer_members" USING btree ("org_id","email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_orgs_root_payer_id_uq" ON "payer_orgs" USING btree ("root_payer_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_org_id_idx" ON "credit_ledger" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "job_postings_org_id_idx" ON "job_postings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "jobs_org_id_idx" ON "jobs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_capacity_org_id_uq" ON "payer_capacity" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_credits_org_id_uq" ON "payer_credits" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "posting_boosts_org_id_idx" ON "posting_boosts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "posting_plans_org_id_idx" ON "posting_plans" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_disclosures_org_worker_posting_uq" ON "resume_disclosures" USING btree ("org_id","worker_id","job_posting_id");--> statement-breakpoint
CREATE INDEX "resume_disclosures_org_id_idx" ON "resume_disclosures" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unlocks_org_worker_uq" ON "unlocks" USING btree ("org_id","worker_id");--> statement-breakpoint
CREATE INDEX "unlocks_org_id_idx" ON "unlocks" USING btree ("org_id");

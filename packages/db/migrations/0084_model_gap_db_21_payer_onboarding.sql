-- ===========================================================================
-- 0084 — MODEL GAP-DB-21: the four payer-onboarding tables that existed only on production
--
-- GENERATED, THEN HAND-FINISHED. `drizzle-kit generate` produced the CREATE TABLE bodies from
-- `src/schema/payer-onboarding.ts` and they are unchanged below except for four things it
-- cannot express, each marked inline:
--   (1) IF NOT EXISTS on every object, because production ALREADY HAS ALL FOUR;
--   (2) DROP-IF-EXISTS before each ADD CONSTRAINT, for the same reason;
--   (3) the `auth.users` foreign key, guarded — it exists on Supabase and nowhere else;
--   (4) FORCE + the four REVOKEs, which drizzle-kit does not model at all (see 0082's header).
-- `meta/0084_snapshot.json` is drizzle's own output and is untouched, so `db:generate` still
-- reports "No schema changes".
--
-- ===========================================================================
-- WHAT THIS MIGRATION DOES, PER ENVIRONMENT
-- ===========================================================================
-- PRODUCTION — a NO-OP in every respect that matters. All four tables exist, are already
-- RLS-enabled and FORCED, and are already revoked from anon/authenticated/service_role (0082).
-- Every CREATE is `IF NOT EXISTS`; every FORCE and REVOKE is idempotent in Postgres. The only
-- statements that DO anything are the foreign-key re-adds, which drop and immediately recreate
-- the identical constraint on a table holding **0 rows**.
--
-- EVERYWHERE ELSE — CI's e2e database, a new staging box, a disaster-recovery rebuild — this is
-- the migration that makes those environments match production. Before it, a fresh database
-- came up WITHOUT these four tables and nothing said so.
--
-- ===========================================================================
-- WHY THEY ARE BEING MODELLED RATHER THAN DROPPED
-- ===========================================================================
-- 0082's header recorded "DROP IS THE BETTER END STATE, AND IS NOT THIS MIGRATION". **The owner
-- ruled the other way on 2026-08-20** (`phase-9-decision-record.md` §6): keep them and model
-- them. Dropping is the only irreversible option available, it buys nothing measurable — 0 rows,
-- 0 inbound FKs, already locked — and a drop migration would have to be written from the live
-- catalog rather than from a model, which is the provenance problem that created GAP-DB-21 in
-- the first place. Their column names (`gst_number_enc`, `invited_email_enc`) read as an
-- unfinished design, and this migration does not prejudge whether that design lives: declaring
-- a table is not wiring it to anything, and nothing in this repository reads any of the four.
--
-- ===========================================================================
-- CONSTRAINT NAMES ARE THE LIVE ONES, DELIBERATELY
-- ===========================================================================
-- Postgres's `_fkey` / `_check` / `_key` defaults, not Drizzle's `_fk` convention, because
-- `adopt-migrations.ts` verifies a migration's constraints against the live catalog BY NAME. A
-- Drizzle-flavoured name would make this migration unadoptable against the single database that
-- already has these tables. The schema file names them explicitly to match.
--
-- ===========================================================================
-- THE MIGRATION SLOT AND ITS `when` — BOTH WERE WRONG WHEN GENERATED
-- ===========================================================================
-- MINTED AS 0083, RENUMBERED TO 0084. `#1130` (`0083_ai_call_traces`) took the slot and landed
-- on `main` while this branch was in flight — the fifth collision this repository has recorded.
-- Regenerated rather than renamed (the 0071 rule): the snapshot was re-derived on top of
-- 0083's, so `0084_snapshot.json.prevId == 0083_snapshot.json.id` and the chain is unbroken.
-- `npx drizzle-kit generate` then reports "No schema changes, nothing to migrate".
--
-- `when = 1787240000000`, hand-raised from the 1787226261060 `db:generate` minted.
--
-- THIS IS LOAD-BEARING, NOT COSMETIC. Drizzle's migrator is a HIGH-WATER MARK, not set
-- membership: it applies a file only when `folderMillis` exceeds the newest recorded
-- `created_at`. `0083_ai_call_traces` carries `when = 1787230000000` and was ALREADY APPLIED to
-- production before it merged — it is the row `adopt-migrations.ts --doctor` was reporting as an
-- unexplained orphan. That is ABOVE the value generated for this file, so left alone 0084 would
-- have been skipped **silently and permanently**: no error, no output, just a fresh database
-- that never gets the four tables and a production database that never records the no-op.
-- Raising it past 0083 is what makes this file reachable at all.
--
-- ===========================================================================
-- SAFETY
-- ===========================================================================
-- IDEMPOTENT. Re-running changes nothing: IF NOT EXISTS on creates, DROP-IF-EXISTS before every
-- constraint add, and FORCE/REVOKE are no-ops when already in force.
--
-- THE FK RE-ADD IS THE ONLY WRITE, and it takes ACCESS EXCLUSIVE on an empty table for the
-- microseconds it runs. Per the 0073/0077/0080/0082 precedent: run under
-- `SET lock_timeout = '3s';` and retry on 55P03.
--
-- FORCE CANNOT LOCK THE APPLICATION OUT — `postgres`, the owner and the only role the backend
-- connects as, has `rolbypassrls = true`. Same argument as 0082, measured the same day.
--
-- ROLLBACK. `DROP TABLE` is NOT the rollback: on production these tables predate this migration
-- and dropping them would destroy state this file did not create. To unwind the MODEL, revert
-- the schema file and this migration in git; to unwind on a FRESH database, where they were in
-- fact created here, drop all four in reverse order. Nothing else here is reversible-by-need:
-- every other statement asserts a state production already had.
-- ===========================================================================

-- ── (1) The four tables. `IF NOT EXISTS`: production already has every one of them. ──
CREATE TABLE IF NOT EXISTS "agency_profiles" (
	"payer_id" uuid PRIMARY KEY NOT NULL,
	"agency_type" text,
	"service_locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"operating_cities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recruiter_count" integer,
	"source_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_profiles_agency_type_check" CHECK ("agency_profiles"."agency_type" IS NULL OR "agency_profiles"."agency_type" IN ('placement_agency', 'contractor', 'training_partner', 'consultant')),
	CONSTRAINT "agency_profiles_verification_status_check" CHECK ("agency_profiles"."verification_status" IN ('pending', 'verified', 'rejected', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "agency_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employer_profiles" (
	"payer_id" uuid PRIMARY KEY NOT NULL,
	"industry" text,
	"company_size" text,
	"hiring_locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gst_number_enc" text,
	"billing_contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"website" text,
	"verification_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employer_profiles_verification_status_check" CHECK ("employer_profiles"."verification_status" IN ('pending', 'verified', 'rejected', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "employer_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payer_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"can_post_jobs" boolean DEFAULT true NOT NULL,
	"can_manage_team" boolean DEFAULT true NOT NULL,
	"can_view_candidates" boolean DEFAULT true NOT NULL,
	"can_unlock_contacts" boolean DEFAULT true NOT NULL,
	"can_manage_billing" boolean DEFAULT true NOT NULL,
	"can_refer_candidates" boolean DEFAULT false NOT NULL,
	"can_manage_payouts" boolean DEFAULT false NOT NULL,
	"can_bulk_upload_candidates" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_capabilities_payer_id_key" UNIQUE("payer_id")
);
--> statement-breakpoint
ALTER TABLE "payer_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payer_member_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"invited_email_hash" text NOT NULL,
	"invited_email_enc" text NOT NULL,
	"role" text NOT NULL,
	"invite_token_hash" text NOT NULL,
	"invited_by_member_id" uuid,
	"accepted_by_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_member_invites_invite_token_hash_key" UNIQUE("invite_token_hash"),
	CONSTRAINT "payer_member_invites_role_check" CHECK ("payer_member_invites"."role" IN ('admin', 'recruiter', 'finance', 'viewer')),
	CONSTRAINT "payer_member_invites_status_check" CHECK ("payer_member_invites"."status" IN ('pending', 'accepted', 'expired', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "payer_member_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── (2) The payer foreign keys. DROP-IF-EXISTS first, because Postgres has no
--        `ADD CONSTRAINT IF NOT EXISTS` and production already carries all four. Drop-then-add
--        of an identical constraint on an empty table is a no-op in effect; `adopt-migrations`
--        reads the pair by offset and correctly treats the constraint as present.
ALTER TABLE "agency_profiles" DROP CONSTRAINT IF EXISTS "agency_profiles_payer_id_fkey";--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD CONSTRAINT "agency_profiles_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employer_profiles" DROP CONSTRAINT IF EXISTS "employer_profiles_payer_id_fkey";--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD CONSTRAINT "employer_profiles_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_capabilities" DROP CONSTRAINT IF EXISTS "payer_capabilities_payer_id_fkey";--> statement-breakpoint
ALTER TABLE "payer_capabilities" ADD CONSTRAINT "payer_capabilities_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_member_invites" DROP CONSTRAINT IF EXISTS "payer_member_invites_payer_id_fkey";--> statement-breakpoint
ALTER TABLE "payer_member_invites" ADD CONSTRAINT "payer_member_invites_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── The indexes. `IF NOT EXISTS`, same reason as the tables. ──
CREATE INDEX IF NOT EXISTS "idx_payer_capabilities_payer_id" ON "payer_capabilities" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payer_member_invites_email_hash" ON "payer_member_invites" USING btree ("invited_email_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payer_member_invites_payer_id" ON "payer_member_invites" USING btree ("payer_id");--> statement-breakpoint

-- ── (3) The `auth.users` foreign key — SUPABASE ONLY, and therefore guarded.
--
-- `payer_member_invites.accepted_by_user_id` references Supabase Auth's user table on
-- production. That schema does not exist on a plain Postgres (CI's e2e database, a developer's
-- docker), and an unconditional ADD would abort this migration there and take the whole slot
-- down — the same failure mode 0082's Section B was guarded against.
--
-- The column is nullable and holds 0 rows in every environment, so its absence constrains
-- nothing. This is the one part of the live shape the Drizzle model deliberately does not
-- carry: modelling it would mean declaring the `auth` schema, and Drizzle would then try to
-- CREATE it.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE NOTICE '0084: auth.users absent — skipping the accepted_by_user_id FK (expected off Supabase)';
    RETURN;
  END IF;
  ALTER TABLE public.payer_member_invites
    DROP CONSTRAINT IF EXISTS payer_member_invites_accepted_by_user_id_auth_users_id_fk;
  ALTER TABLE public.payer_member_invites
    ADD CONSTRAINT payer_member_invites_accepted_by_user_id_auth_users_id_fk
    FOREIGN KEY (accepted_by_user_id) REFERENCES auth.users(id);
  RAISE NOTICE '0084: accepted_by_user_id -> auth.users(id) in place';
END $$;--> statement-breakpoint

-- ── (4) The lock, restated so a FRESH database comes up locked rather than open.
--
-- 0082 locked these four on production behind a `to_regclass` guard, precisely because they did
-- not exist anywhere else. Now they will: the CREATEs above bring them into being on every
-- fresh database, and Supabase's default privileges would grant the Data-API roles at CREATE
-- time. Restating the lock here is what stops this migration from re-opening, on every new
-- environment, exactly the hole 0082 closed.
--
-- Unconditional and idempotent: FORCE on an already-forced table and REVOKE of an absent grant
-- are both no-ops in Postgres, not errors, so this is silent on production.
ALTER TABLE "agency_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_profiles" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_profiles" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_profiles" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_profiles" FROM service_role;--> statement-breakpoint

ALTER TABLE "employer_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "employer_profiles" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "employer_profiles" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "employer_profiles" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "employer_profiles" FROM service_role;--> statement-breakpoint

ALTER TABLE "payer_capabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capabilities" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capabilities" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capabilities" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capabilities" FROM service_role;--> statement-breakpoint

ALTER TABLE "payer_member_invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_member_invites" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_member_invites" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_member_invites" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_member_invites" FROM service_role;

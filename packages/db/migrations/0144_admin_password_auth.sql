-- ==============================================================================
-- 0144 - admin password sign-in + optional two-step (ADR-0060, owner rulings 2026-11-03)
-- ==============================================================================
--
-- Additive only: five new `admin_users` columns. Nothing existing is altered, dropped or
-- rewritten; no CHECK, no UNIQUE, no index, no data backfill.
--   * password_hash / password_set_at / password_pepper_version — nullable, no default. The
--     payer #2497 (0138) scheme: a `password-v1.` scrypt token + its pepper version. NULL =
--     the admin has no password yet and keeps signing in by emailed code (unchanged door).
--     password_set_at is ALSO the credential epoch: every admin JWT carries it as `pwe`, and
--     a session whose `pwe` differs from the row is rejected, so a reset signs every session out.
--   * must_change_password — NOT NULL DEFAULT false. True only for an account a super_admin
--     created directly with a temporary password.
--   * mfa_enabled — NOT NULL DEFAULT false. Each admin's OWN two-step switch (two-step is
--     optional, per admin). Distinct from mfa_enrolled (a confirmed TOTP seed exists) — enabled
--     is what the sign-in gate reads. Owner ruling: two-step starts OFF for EVERYONE, including
--     an admin who already enrolled an authenticator — so there is
--     deliberately NO `mfa_enabled = mfa_enrolled` backfill.
--
-- PRODUCTION HISTORY. Written as 0142 and HAND-APPLIED to production by the owner on
-- 2026-11-03 (the same five columns, with ADD COLUMN IF NOT EXISTS), then renumbered to 0144
-- because main gained its own 0142/0143 (PLC role_kind). Production's drizzle ledger does not
-- record it (nor 0142/0143) — insert the three ledger rows in order before anyone runs
-- `db:migrate` against production, or this plain ADD COLUMN fails "already exists".
--
-- APPLY-BEFORE-DEPLOY. Manual apply BEFORE the build that reads these columns deploys (code
-- auto-deploys on merge; migrations never do). `AdminRepository` reads `admin_users` through bare `select()` /
-- `.returning()`, which name EVERY model column, and `AdminSessionService.validateAndTouch`
-- runs findById on EVERY admin request — so the new build against an unmigrated database 500s
-- every admin sign-in AND every signed-in admin route. The OLD build on a migrated database is
-- fine (a superset). Registered as `0144-admin-users-password-hash` in `schema-contract.ts`.
--
-- LOCKS. Nullable ADD COLUMN and a constant-DEFAULT NOT NULL ADD COLUMN are catalog-only
-- (PG11+ fast default) but still take a brief ACCESS EXCLUSIVE on `admin_users`, which is read
-- on every admin request — take it with a short timeout and retry on 55P03.
--
-- ROLLBACK: drop the five added columns
--   ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "mfa_enabled";
--   ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "must_change_password";
--   ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "password_pepper_version";
--   ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "password_set_at";
--   ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "password_hash";
-- only AFTER rolling the API back to a build that does not name them. Dropping them deletes
-- every admin password (admins fall back to the emailed-code sign-in) and every admin's
-- two-step choice (the pre-0144 build asks TOTP of everyone again).
SET lock_timeout='3s';--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_pepper_version" integer;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;
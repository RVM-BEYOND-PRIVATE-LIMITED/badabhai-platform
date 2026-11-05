-- ==============================================================================
-- 0154 - payer login management: temporary password, revoke, session invalidation (#2563)
-- ==============================================================================
--
-- Additive only: four new `payers` columns. Nothing existing is altered, dropped or
-- rewritten; no CHECK, no UNIQUE, no index, no data backfill.
--   * must_change_password - NOT NULL DEFAULT false. True while the stored password is a
--     TEMPORARY one an admin issued. A password sign-in returns
--     `password_change_required` and mints NO session; email-code sign-in refuses with 409
--     for the same reason, so the code door cannot bypass the change. Cleared in the same
--     write that stores the payer's own password.
--   * password_revoked_at - nullable, no default. When an admin revoked password sign-in.
--     A non-NULL value with no newer `password_set_at` means the password door is off;
--     email-code sign-in still works. Cleared when a new password is stored.
--   * sessions_valid_after - nullable, no default. Sessions created at or before this
--     instant are dead. An admin issue/revoke stamps it and ends every session. A
--     self-service password set does NOT stamp it (that would reject the caller's own
--     session); it revokes the OTHER sessions through the session index. NULL (every payer
--     on deploy) leaves existing sessions unaffected.
--   * last_login_at - nullable, no default. Last successful payer sign-in (OTP or password).
--
-- APPLY-BEFORE-DEPLOY. Manual apply BEFORE the build that reads these columns deploys (code
-- auto-deploys on merge; migrations never do). `PayersRepository` reads `payers` through
-- bare `select()` / `.returning()`, which name EVERY model column, and `PayerAuthGuard`
-- resolves auth facts on EVERY payer request - so the new build against an unmigrated
-- database 500s payer authentication and every guarded payer route. The OLD build on a
-- migrated database is fine (a superset). Registered as `0154-payers-sessions-valid-after`
-- in `schema-contract.ts`.
--
-- LOCKS. Nullable ADD COLUMN and a constant-DEFAULT NOT NULL ADD COLUMN are catalog-only
-- (PG11+ fast default) but still take a brief ACCESS EXCLUSIVE on `payers`, which is read on
-- every payer request - take it with a short timeout and retry on 55P03.
--
-- ROLLBACK: drop the four added columns
--   ALTER TABLE "payers" DROP COLUMN IF EXISTS "last_login_at";
--   ALTER TABLE "payers" DROP COLUMN IF EXISTS "sessions_valid_after";
--   ALTER TABLE "payers" DROP COLUMN IF EXISTS "password_revoked_at";
--   ALTER TABLE "payers" DROP COLUMN IF EXISTS "must_change_password";
-- only AFTER rolling the API back to a build that does not name them. Dropping them loses
-- the login timestamps and the session-invalidation watermark (sessions created before a
-- rollback become valid again), and turns every temporary-password account back into an
-- ordinary password account.
SET lock_timeout='3s';--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "password_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "sessions_valid_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "last_login_at" timestamp with time zone;

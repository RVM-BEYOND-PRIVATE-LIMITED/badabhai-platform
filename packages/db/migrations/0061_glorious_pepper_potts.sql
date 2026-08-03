ALTER TABLE "payers" ADD COLUMN "previous_status" text;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ADR-0037 — payer lifecycle backfill.
--
-- `payers.status` defaults to 'pending' and, before this change, NOTHING ever
-- promoted a payer to 'active': the signup path never set it and the verify path
-- never touched it. So every real payer in every environment is 'pending'.
--
-- Once PayerAuthGuard requires 'active', arming it without this backfill LOGS OUT
-- EVERY EXISTING PAYER — and no e2e would catch it (the payer e2e suite is `.skip`
-- and its `dev_otp` helper has no producer). That is why the backfill ships in the
-- SAME migration as the column, ahead of the guard change (expand → migrate →
-- contract, deployed separately).
--
-- WHO gets activated: only payers with PROVABLE proof-of-verification. The
-- `payer.session_started` event is emitted at exactly one place — inside
-- `verifyLogin`, AFTER `otp.verify` succeeds and AFTER the account is confirmed to
-- exist. Its presence is therefore evidence the payer controlled the mailbox and
-- passed a real OTP. That is precisely the bar the new lifecycle sets, applied
-- retroactively.
--
-- WHO does NOT: a payer who signed up but never completed an OTP login stays
-- 'pending' and must verify like any new account. Never-verified signups are not
-- silently promoted.
--
-- A 'suspended' payer is untouched (the WHERE pins status='pending'), so this can
-- never resurrect a suspended account.
--
-- IDEMPOTENT: re-running matches no rows once the payers are 'active'.
-- REVERSIBLE: see the rollback note in the PR — the inverse is
--   UPDATE payers SET status='pending' WHERE status='active' AND previous_status IS NULL;
-- but note it cannot distinguish these backfilled rows from ones activated later by
-- a real verify, so roll back by redeploying the previous API build instead.
-- ---------------------------------------------------------------------------
UPDATE "payers" SET "status" = 'active', "updated_at" = now()
WHERE "status" = 'pending'
  AND "id" IN (
    SELECT DISTINCT "subject_id" FROM "events"
    WHERE "event_name" = 'payer.session_started' AND "subject_id" IS NOT NULL
  );

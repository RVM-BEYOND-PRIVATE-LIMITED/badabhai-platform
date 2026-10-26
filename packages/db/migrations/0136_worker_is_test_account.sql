-- ==============================================================================
-- 0136 - workers.is_test_account: the test-traffic marker (A5)
-- ==============================================================================
--
-- Non-PII boolean, default FALSE: every existing row keeps today's behaviour.
-- Set at login from the plaintext number (the only moment it is in hand);
-- backfill of old rows happens lazily on their next login, never by decrypting.
ALTER TABLE "workers" ADD COLUMN "is_test_account" boolean DEFAULT false NOT NULL;
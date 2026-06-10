-- Harden workers PII + carry the interview conversation_state column.
--
-- workers (PII hardening, closes TD3/TD4 for this table):
--   * ENABLE RLS so the table is policy-gated for non-BYPASSRLS roles. FORCE +
--     the REVOKEs land in 0004.
--   * DROP the plaintext-phone unique index: phone_e164 now stores
--     non-deterministic AES-256-GCM ciphertext, so dedup/uniqueness lives on the
--     keyed-HMAC phone_hash (workers_phone_hash_uq, kept).
-- chat_sessions:
--   * conversation_state jsonb — persisted interview state across chat turns.
--
-- IF EXISTS / IF NOT EXISTS guards: these new-chain files were regenerated on top
-- of the storage 0002 during integration and have never been applied anywhere, so
-- the guards are safe to add. They let `db:migrate` converge a drifted DB (e.g. the
-- live Supabase, which already had RLS + the dropped index from the pre-merge chain)
-- in one idempotent pass instead of manual journal surgery. ENABLE RLS is already a
-- no-op when RLS is on.
ALTER TABLE "workers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "workers_phone_e164_uq";--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "conversation_state" jsonb;

-- Harden worker PII (closes TD3/TD4 for the workers table).
--
-- 1. The plaintext-phone unique index is obsolete: phone_e164 now stores
--    non-deterministic AES-256-GCM ciphertext, so uniqueness/dedup lives on the
--    keyed-HMAC phone_hash (which keeps its unique index).
DROP INDEX IF EXISTS "workers_phone_e164_uq";--> statement-breakpoint

-- 2. Row-Level Security: lock `workers` to the backend service role only.
--    The backend connects as the `postgres` role (BYPASSRLS), so it is
--    unaffected. The Supabase client-facing roles get denied-by-default (no
--    policy is created), and we also REVOKE table grants as defense-in-depth.
ALTER TABLE "workers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM authenticated;

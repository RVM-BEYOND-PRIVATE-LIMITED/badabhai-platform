-- ADMIN-3a H2 — EXACTLY-ONCE money guard on credit_ledger (ADR-0025). ADDITIVE + backward-
-- compatible: a NULLABLE opaque key column + a UNIQUE index. Postgres NULLS DISTINCT means every
-- existing/legacy row (idempotency_key IS NULL) is treated as distinct and never collides, so no
-- backfill is needed and all current writers keep working unchanged. A duplicate admin-grant key
-- now inserts NO second ledger row (the repository ON CONFLICT DO NOTHINGs), and the matching
-- `credits_granted` event is keyed on the SAME value — so ledger + spine agree (no double-spend,
-- no money-vs-spine divergence). credit_ledger already has FORCE RLS + REVOKE (spine posture);
-- this column adds no PII (an opaque UUID only). No LOCKED_TABLES change (column on an existing,
-- already-covered table).
--
-- ROLLBACK (safe, no data loss for the spine/balance):
--   DROP INDEX IF EXISTS "credit_ledger_idempotency_key_uq";
--   ALTER TABLE "credit_ledger" DROP COLUMN IF EXISTS "idempotency_key";
-- After rollback the grant path loses exactly-once (reverts to append-on-every-call) but the
-- existing ledger rows + balances are unaffected.
ALTER TABLE "credit_ledger" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_uq" ON "credit_ledger" USING btree ("idempotency_key");
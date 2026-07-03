-- =====================================================================================
-- 0036 — ADR-0027 B5.x Increment 6 (CONTRACT). The FINAL increment of the
-- payer_id -> org_id org-tenancy program. Inc 1-5 flipped every payer-owned resource +
-- the money wallet / capacity / ledger / disclosures onto org_id at the app chokepoints;
-- this migration retires the two OLD per-payer arbiters that those org-keyed writes could
-- still collide with, and closes the org_id ORM-vs-DB drift.
--
-- WHAT THIS DOES (purely index-drop + constraint-tighten — NO column drop, NO data loss,
-- fully reversible):
--   1. DROP the two OLD per-payer UNIQUE indexes on the wallet + capacity tables:
--      "payer_credits_payer_id_uq" and "payer_capacity_payer_id_uq". They are replaced by
--      a plain (non-unique) payer_id index (step 3) so payer_id lookups keep their index.
--   2. SET NOT NULL on org_id for the 7 tables whose payer_id is NOT NULL. These are
--      REDUNDANT on an already-0035-migrated DB (0035 already SET NOT NULL on the same 7)
--      but correct + idempotent — Postgres SET NOT NULL on an already-NOT-NULL column is a
--      no-op. This exists so schema.ts (now modeling org_id NOT NULL) == the snapshot.
--   3. CREATE the plain payer_id indexes that replace the dropped uniques.
--
-- WHY (two tracked launch-gates, both closed here):
--   - SHARED-ORGS COLLISION: with the OLD "*_payer_id_uq" still present, an org-keyed
--     INSERT ... ON CONFLICT (org_id) upsert (Inc 2/3) could still trip the retained
--     payer_id UNIQUE arbiter under multi-membership (two payers in one org sharing a
--     single wallet/capacity row) -> a spurious dup-key 500. Dropping the payer_id UNIQUE
--     makes the org-scoped unique ("payer_credits_org_id_uq" / "payer_capacity_org_id_uq",
--     from 0035) the SOLE wallet/capacity uniqueness, so the upserts no longer collide.
--   - org_id ORM-vs-DB DRIFT: org_id was DB-NOT-NULL on the 7 tables since 0035 but modeled
--     NULLABLE in schema.ts. Modeling it NOT NULL (Inc 6) + re-emitting the (no-op) SET NOT
--     NULL keeps schema.ts and the DB in sync so a future db:generate diff stays clean.
--
-- NOT TOUCHED: jobs.org_id and job_postings.org_id stay NULLABLE (ops/seed rows carry NULL
-- payer_id + NULL org_id; the partial "*_org_id_when_payer_chk" CHECKs from 0035 tie them).
-- The payer_id COLUMNS are RETAINED everywhere (still NOT NULL, still stamped) for
-- rollback/audit — no column is dropped.
--
-- PII-free (org_id / payer_id are opaque uuids). Idempotent (IF EXISTS on the drops, IF NOT
-- EXISTS on the recreates, SET NOT NULL is a no-op on already-not-null columns) — a partial
-- re-run is safe.
--
-- ROLLBACK (fully reversible; the app path is unaffected — Inc 1-5 read org_id, and org_id
-- is genuinely populated on every row, so NO "SET NULL" is needed):
--   -- Restore the two per-payer UNIQUE arbiters (drop the plain replacements first):
--   DROP INDEX IF EXISTS "payer_credits_payer_id_idx";
--   DROP INDEX IF EXISTS "payer_capacity_payer_id_idx";
--   CREATE UNIQUE INDEX IF NOT EXISTS "payer_credits_payer_id_uq"   ON "payer_credits"  USING btree ("payer_id");
--   CREATE UNIQUE INDEX IF NOT EXISTS "payer_capacity_payer_id_uq" ON "payer_capacity" USING btree ("payer_id");
--   -- The org_id SET NOT NULLs need NO rollback: 0035 already made them NOT NULL and org_id
--   -- is genuinely populated. (If ever reverting BELOW 0035, that migration's own rollback
--   -- ALTER ... DROP COLUMN "org_id" removes the constraint with the column.)
-- =====================================================================================

-- ── 1. Retire the two OLD per-payer UNIQUE arbiters (reversible — recreated in ROLLBACK). ──
DROP INDEX IF EXISTS "payer_capacity_payer_id_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "payer_credits_payer_id_uq";--> statement-breakpoint

-- ── 2. Re-assert org_id NOT NULL on the 7 payer-owned tables (no-op on an already-0035-
-- migrated DB — SET NOT NULL on an already-NOT-NULL column is harmless; this closes the
-- schema.ts-vs-DB drift so future db:generate diffs stay clean). ──────────────────────────
ALTER TABLE "credit_ledger" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_capacity" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_credits" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posting_boosts" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posting_plans" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "unlocks" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- ── 3. Plain (non-unique) payer_id indexes replacing the dropped uniques (preserve the
-- payer_id lookups the old unique indexes used to serve). ─────────────────────────────────
CREATE INDEX IF NOT EXISTS "payer_capacity_payer_id_idx" ON "payer_capacity" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_credits_payer_id_idx" ON "payer_credits" USING btree ("payer_id");

-- ROLLBACK: DROP INDEX IF EXISTS "workers_deletion_due_idx";
--           ALTER TABLE "workers" DROP COLUMN IF EXISTS "deletion_scheduled_at";
--   (Rollback is safe: the column's only readers are feature-new + NULL-tolerant;
--    NULL = active, so dropping it returns deletion to ADR-0026 immediate erasure.)
-- Additive only (one nullable column + a partial index on `workers`); no data rewrite.
-- ADR-0031 (Accepted 2026-07-14) — 7-day account-deletion grace window.
ALTER TABLE "workers" ADD COLUMN "deletion_scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workers_deletion_due_idx" ON "workers" USING btree ("deletion_scheduled_at") WHERE "deletion_scheduled_at" IS NOT NULL;
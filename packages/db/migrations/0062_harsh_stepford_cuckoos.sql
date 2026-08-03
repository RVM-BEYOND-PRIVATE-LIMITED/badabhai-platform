-- ---------------------------------------------------------------------------
-- ADR-0037 (Decision 1) — a suspended payer's inventory becomes non-discoverable.
--
-- PR #553 made suspension bite on the payer's SESSION. It did not touch their
-- INVENTORY: `payers` is joined nowhere in the feed/reach/jobs/applications path, so
-- an "open" posting owned by a banned payer stayed in the worker feed and kept
-- accepting applications indefinitely. This migration adds the storage the cascade
-- needs to fix that.
--
-- EXPAND-ONLY. Every statement here is additive or widening:
--   * a new NULLABLE column (no default, no backfill — no existing row changes),
--   * two new indexes,
--   * the status CHECK is WIDENED (every value it accepted before it still accepts),
--   * one new CHECK that is vacuously true for every existing row (they all have
--     previous_status IS NULL, because the column did not exist a statement ago).
-- So this can be applied AHEAD of the API build with zero behaviour change, and the
-- old build keeps running against the new schema (invariant #8).
--
-- ROLLBACK: drop the two CHECKs, the two indexes and the column. Safe at any time
-- while no payer is suspended. If a payer IS suspended, reinstate them FIRST —
-- dropping `previous_status` while rows are 'suspended' loses the state they must be
-- restored to, and those rows would then be stranded in a status the widened CHECK no
-- longer permits.
-- ---------------------------------------------------------------------------

-- The status CHECK is swapped, not edited — Postgres has no ALTER CONSTRAINT for a
-- CHECK expression. Both statements are in the SAME migration, which the Drizzle
-- migrator runs in ONE transaction, so `job_postings` is never left unconstrained to a
-- concurrent writer.
ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_status_chk";--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_status_chk" CHECK ("job_postings"."status" IN ('draft', 'open', 'paused', 'suspended', 'closed'));--> statement-breakpoint

-- The live status a posting held before its owner was suspended, so reinstatement
-- restores it EXACTLY. NULL for every row that is not currently suspended.
ALTER TABLE "job_postings" ADD COLUMN "previous_status" text;--> statement-breakpoint

-- `previous_status` describes a SUSPENSION and nothing else: a non-suspended row must
-- carry NULL. Without this a stale value could survive a reinstate and later be
-- restored onto a posting the payer had since closed.
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_previous_status_chk" CHECK (("job_postings"."status" = 'suspended') OR ("job_postings"."previous_status" IS NULL));--> statement-breakpoint

-- Both cascades are `WHERE payer_id = $1 AND status IN (...)`.
-- `jobs.payer_id` had NO index at all before this — every agency-owned read of that
-- table was a sequential scan, not just the new cascade.
CREATE INDEX "job_postings_payer_id_status_idx" ON "job_postings" USING btree ("payer_id","status");--> statement-breakpoint
CREATE INDEX "jobs_payer_id_status_idx" ON "jobs" USING btree ("payer_id","status");

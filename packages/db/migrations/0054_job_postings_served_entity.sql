-- Matching V1 — step 3 of 7: `job_postings` becomes THE SERVED JOB ENTITY.
--
-- Owner ruling (CEO ratification 2026-07-30): the worker feed serves `job_postings`;
-- the legacy `jobs` table retires from the worker path. This migration gives
-- `job_postings` the fields `jobs` had and it lacked, plus the V1 match inputs.
--
-- EXPAND-ONLY, and specifically:
--   * `jobs` is NOT dropped, NOT renamed and NOT altered. It keeps serving whatever
--     still reads it, and every `applications.job_id` row keeps resolving forever.
--   * every new column is NULLABLE, or NOT NULL **with a constant DEFAULT** — so each
--     ADD COLUMN is a catalog-only change on Postgres 11+ (no rewrite, no long lock),
--     and every already-shipped ops/payer read of this table is byte-for-byte unchanged.
--   * a posting that existed before this migration gets match_skill_ids = '[]' →
--     it reaches nobody. That is FAIL-CLOSED, not a crash. D3 backfills published_at
--     and PROPOSES match ids; anything it cannot resolve is left empty and printed to
--     an ops worklist rather than guessed.
--
-- NEW COLUMNS: industry_id, match_skill_ids, reach_skill_ids, city, pay_min, pay_max,
--   shift, needed_by, published_at, boosted_until, source_job_id.
-- NEW INDEXES: job_postings_feed_idx (status, published_at DESC) — the feed;
--   job_postings_reach_gin (GIN jsonb_path_ops on reach_skill_ids) — the per-worker
--   reconciliation `reach_skill_ids ?| $workerSkills`;
--   job_postings_source_job_id_uq — what makes the D4 cutover converter idempotent.
-- NEW CHECKS: pay non-negative / pay ordered / shift enum / needed_by enum — mirrored
--   verbatim from the equivalents on `jobs`.
--
-- PRIVACY: `city` is a COARSE city bucket (never an address); pay is an integer ₹ band;
-- shift/needed_by are coarse enums. No employer identity is introduced.
--
-- LOCKS: the ADD COLUMNs are metadata-only. The FOUR `ADD CONSTRAINT ... CHECK` and the
-- three CREATE INDEX statements each take a strong lock on `job_postings` and scan it.
-- The table is small today (hundreds/low thousands of rows) so this is seconds. IF the
-- table is large when you apply this, do it in two passes instead:
--   ALTER TABLE ... ADD CONSTRAINT ... CHECK (...) NOT VALID;   -- instant
--   ALTER TABLE ... VALIDATE CONSTRAINT ...;                    -- concurrent-safe scan
--   CREATE INDEX CONCURRENTLY ...;                              -- out of band, then this
--                                                               -- migration is a no-op
--
-- ROLLBACK (fully reversible — no existing data is read, rewritten, or destroyed):
--   DROP INDEX IF EXISTS "job_postings_feed_idx";
--   DROP INDEX IF EXISTS "job_postings_reach_gin";
--   DROP INDEX IF EXISTS "job_postings_source_job_id_uq";
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_pay_nonneg_chk";
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_pay_order_chk";
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_shift_chk";
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_needed_by_chk";
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_source_job_id_jobs_id_fk";
--   ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "industry_id", ... (all 11);
-- CAVEAT: dropping these columns AFTER the D4 cutover has run and closed the `jobs`
-- rows leaves the worker feed empty (the postings survive but carry no match ids). The
-- data-level undo for D4 is documented in the runbook (reopen the jobs rows, delete the
-- converted postings by source_job_id) — do that FIRST if you are rolling back a live cutover.
ALTER TABLE "job_postings" ADD COLUMN "industry_id" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "match_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "reach_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "pay_min" integer;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "pay_max" integer;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "shift" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "needed_by" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "boosted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "source_job_id" uuid;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_source_job_id_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_postings_feed_idx" ON "job_postings" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_postings_reach_gin" ON "job_postings" USING gin ("reach_skill_ids" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "job_postings_source_job_id_uq" ON "job_postings" USING btree ("source_job_id");--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_pay_nonneg_chk" CHECK (("job_postings"."pay_min" IS NULL OR "job_postings"."pay_min" >= 0) AND ("job_postings"."pay_max" IS NULL OR "job_postings"."pay_max" >= 0));--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_pay_order_chk" CHECK ("job_postings"."pay_min" IS NULL OR "job_postings"."pay_max" IS NULL OR "job_postings"."pay_max" >= "job_postings"."pay_min");--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_shift_chk" CHECK ("job_postings"."shift" IS NULL OR "job_postings"."shift" IN ('day', 'night', 'rotational'));--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_needed_by_chk" CHECK ("job_postings"."needed_by" IS NULL OR "job_postings"."needed_by" IN ('immediate', 'soon', 'flexible'));
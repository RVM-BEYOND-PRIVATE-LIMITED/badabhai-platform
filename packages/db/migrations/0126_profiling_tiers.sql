-- ==============================================================================
-- 0126 - tiered profiling: question_pack_item.min_tier + worker_profiling_tier
-- ==============================================================================
--
-- Tiered profiling (docs/profiling-tiers/tier-tagging.md). On the Chat path a
-- form-routed worker chooses Easy, Medium or Hard; the form asks only that tier's
-- questions and the résumé prints only that tier's rows. Hard is today's full
-- profiling. Everything that READS what this migration adds is behind
-- PROFILING_TIERS_ENABLED (default off).
--
-- ADDITIVE ONLY. One new nullable column, one new table, one backfill INSERT into
-- that new table. No existing column, constraint or row is modified.
--
-- RENUMBERED FROM 0125, AND IDEMPOTENT ON PURPOSE. This was authored as
-- `0125_profiling_tiers` while #1692 minted `0125_resume_history` on another
-- branch; #1692 merged first. It was reported (2026-09-24, NOT verified from this
-- branch) that a `db:migrate` run from the uncommitted 0125 tree reached
-- production, so `min_tier` / `qpi_min_tier_chk` - and possibly the table - may
-- already exist there, with a ledger row (created_at 1790238246530) for a tag
-- that is not on main. Every statement below therefore tolerates its object
-- already existing: CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, and each
-- ADD CONSTRAINT inside a DO block that swallows only duplicate_object. Applying
-- it where 0125_profiling_tiers already ran is a no-op; applying it fresh builds
-- everything. RECONCILING THE PRODUCTION LEDGER (the stray 0125_profiling_tiers
-- row, and main's 0125_resume_history, reported live with no row) IS AN OWNER
-- DECISION - see MIGRATIONS.md - and nothing here touches `__drizzle_migrations`.
--
-- (1) question_pack_item.min_tier - nullable text, NULL-tolerant CHECK over the closed
--     PROFILING_TIERS set. NULL = hard = asked exactly as before. It is the projection
--     of each pack JSON item's `min_tier`, and only `db:seed:packs --apply` fills it
--     (items are delete-then-insert per pack version, so the existing v1 rows are
--     rewritten in place with no version bump). UNTIL THAT SEED RUNS every row is NULL,
--     which is today's behaviour - so the order migrate -> seed -> flag on is safe, and
--     so is any prefix of it.
--
-- (2) worker_profiling_tier - one row per worker (PK = worker_id, cascade on worker
--     delete). Holds the tier the form asks and the résumé renders at, plus the form
--     session it was chosen on and when (the completion event's duration start). A
--     separate table and NOT a column on `workers`: a bare `workers` select names every
--     model column, so a column there would 500 every worker read on a build that
--     reaches this database before this migration does. NOT PII: ids, closed-set
--     tiers, a closed form kind, timestamps.
--
-- (3) BACKFILL: every worker who had ALREADY PROFILED gets tier 'hard', source
--     'backfill' - they went through full profiling. "Already profiled" = holds a
--     worker_profiles row or any worker_pack_answer row. A worker with neither has not
--     profiled and gets no row: the tier screen is for him. The code also reads a
--     missing row as hard, so a worker who profiles between this apply and the flag
--     going on is still rendered exactly as before.
--
-- DEPLOY ORDER. No API path names the table or the column while the flag is off, so a
-- deploy ahead of this migration breaks no request. BUT THE PACK SEEDER WRITES min_tier
-- UNCONDITIONALLY: `db:seed:packs --apply` from this code fails (and rolls back, leaving
-- the live packs untouched) until 0126 is applied. So: APPLY BEFORE THE NEXT PACK SEED and
-- before the flag (registered in schema-contract.ts as 0126-*). Then run
-- `pnpm --filter @badabhai/db db:seed:packs --apply` so the 11 enabled trade packs carry
-- their tags, then flip the flag. A pack not yet re-seeded has no tags, and the API treats
-- tiers as OFF for that form rather than serving an empty Easy tier.
--
-- LOCKS. ADD COLUMN on question_pack_item with no default is a catalog-only change
-- (ACCESS EXCLUSIVE, no rewrite, milliseconds); ADD CONSTRAINT ... CHECK scans the
-- table (~2k rows). Wrap in one BEGIN/COMMIT with SET LOCAL lock_timeout = '3s' and
-- retry on 55P03 (0077/0080/0109 precedent). The CREATE TABLE and the INSERT touch
-- nothing live.
--
-- ROLLBACK (after turning PROFILING_TIERS_ENABLED off - nothing else reads these):
--   DROP TABLE "worker_profiling_tier";
--   ALTER TABLE "question_pack_item" DROP CONSTRAINT "qpi_min_tier_chk";
--   ALTER TABLE "question_pack_item" DROP COLUMN "min_tier";
-- Dropping the column loses only seeded tags, which the pack JSON re-derives on the
-- next seed. Dropping the table loses the tiers workers CHOSE; with the flag off
-- every worker renders as hard, exactly as before this migration.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS "worker_profiling_tier" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"tier" text NOT NULL,
	"source" text NOT NULL,
	"upgraded_from" text,
	"form_kind" text,
	"chat_session_id" uuid,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wpt_tier_chk" CHECK ("worker_profiling_tier"."tier" IN ('easy', 'medium', 'hard')),
	CONSTRAINT "wpt_upgraded_from_chk" CHECK ("worker_profiling_tier"."upgraded_from" IS NULL OR "worker_profiling_tier"."upgraded_from" IN ('easy', 'medium', 'hard')),
	CONSTRAINT "wpt_source_chk" CHECK ("worker_profiling_tier"."source" IN ('selected', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "worker_profiling_tier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_pack_item" ADD COLUMN IF NOT EXISTS "min_tier" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "worker_profiling_tier" ADD CONSTRAINT "worker_profiling_tier_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "question_pack_item" ADD CONSTRAINT "qpi_min_tier_chk" CHECK ("question_pack_item"."min_tier" IS NULL OR "question_pack_item"."min_tier" IN ('easy', 'medium', 'hard'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- HAND-APPENDED: the platform-wide table-DEFAULT lock (TD20). drizzle-kit models ENABLE and
-- nothing else, so FORCE + the four REVOKEs are exactly what a regenerate drops.
ALTER TABLE "worker_profiling_tier" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiling_tier" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiling_tier" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiling_tier" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiling_tier" FROM service_role;--> statement-breakpoint
-- HAND-APPENDED: (3) the backfill. Idempotent (ON CONFLICT DO NOTHING), so a re-run is a no-op.
INSERT INTO "worker_profiling_tier" ("worker_id", "tier", "source")
SELECT w."id", 'hard', 'backfill'
  FROM "workers" AS w
 WHERE EXISTS (SELECT 1 FROM "worker_profiles" AS p WHERE p."worker_id" = w."id")
    OR EXISTS (SELECT 1 FROM "worker_pack_answer" AS a WHERE a."worker_id" = w."id")
ON CONFLICT ("worker_id") DO NOTHING;

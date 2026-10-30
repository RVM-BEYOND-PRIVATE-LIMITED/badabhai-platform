-- ==============================================================================
-- 0137 - worker_profile_skill.trade_level + level_confirmed (Middle Way P1)
-- ==============================================================================
--
-- Additive only: two new nullable-safe columns, no CHECK, no index change,
-- old `level` untouched. Display-only in v1 — match-engine never reads them.
-- `trade_level` validation is app-level (docs/middle-way/LADDERS.md) so new
-- ladders never need a migration. Existing rows get NULL / false (not stated).
-- Manual apply by Divyanshu before P2 (which reads the columns).
ALTER TABLE "worker_profile_skill" ADD COLUMN "trade_level" text;--> statement-breakpoint
ALTER TABLE "worker_profile_skill" ADD COLUMN "level_confirmed" boolean DEFAULT false NOT NULL;

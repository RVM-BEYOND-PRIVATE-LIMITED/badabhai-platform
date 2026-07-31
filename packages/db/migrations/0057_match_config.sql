-- Matching V1 — step 6 of 7: `match_config`, the rank rule's knobs.
--
-- EXPAND-ONLY: one NEW table, a deliberate CLONE of the `pricing_catalog` shape
-- (ADR-0013 Decision A) — one ACTIVE jsonb row + monotonic revision + partial unique on
-- is_active + opaque updated_by + timestamps. Prior revisions stay as history rows.
--
-- NO VALUES ARE SEEDED HERE. The migration ships STRUCTURE; `db:seed:match:vocabulary`
-- (D1) inserts the single active row if absent — exactly the pricing split, and it is
-- what lets the config be corrected without a migration. A migration that INSERTed
-- config would also be a migration that silently reverted an ops edit on re-apply.
--
-- V1 values the seeder writes: engine_version "v1.0" · month_bucket 6 ·
-- max_skills_per_posting 3 · related_skills_default "on" ·
-- max_consecutive_same_company 2 · applicant_quota "off" · tier_floor_months 36 ·
-- free_unlock_credits 50 · boost_supply_floor 25.
--
-- FAIL-CLOSED CONTRACT (mirrors @badabhai/pricing): the engine loads the ACTIVE row and
-- VALIDATES it before use; an unparseable row falls back to the typed default rather
-- than being trusted. This table is ops-editable — treat its contents as untrusted.
--
-- PII-FREE: enum-ish strings and integers only. Invariant #4: deterministic rule
-- parameters; no LLM writes or reads them.
--
-- LOCKS: CREATE TABLE only — no lock on any live table.
--
-- ROLLBACK (fully reversible; the values are re-seedable from D1):
--   DROP TABLE "match_config";
CREATE TABLE "match_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "match_config_active_uq" ON "match_config" USING btree ("is_active") WHERE "match_config"."is_active";--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20): FORCE RLS + REVOKE ALL for every Data-API role.
-- drizzle-kit emits ENABLE only (above). `pricing_catalog`, the table this clones, is
-- REVOKE-locked by its own migration; this one additionally FORCEs, matching the newer
-- 0048/0050 posture. Registered in tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "match_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "match_config" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "match_config" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "match_config" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "match_config" FROM service_role;
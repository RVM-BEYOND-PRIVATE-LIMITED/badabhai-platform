-- ADR-0016 (per-payer hiring capacity, signed PHASE-0 2026-06-17). ADDITIVE ONLY
-- (CLAUDE.md §2 #8 / ADR-0014): ADD TABLE payer_capacity + widen posting_plans status
-- enum (CHECK swap, prior values stay valid) + same-migration RLS lock. No data rewrite,
-- no column drop, faceless (opaque payer_id, NO FK, NO PII).
--
-- ROLLBACK:
--   ALTER TABLE "posting_plans" DROP CONSTRAINT "posting_plans_status_chk";
--   ALTER TABLE "posting_plans" ADD CONSTRAINT "posting_plans_status_chk"
--     CHECK ("posting_plans"."status" IN ('draft', 'active', 'expired'));
--   DROP INDEX "payer_capacity_payer_id_uq";
--   DROP TABLE "payer_capacity";
--   (Restoring the narrower status CHECK is only safe if no posting_plans row is in
--    status='paused'; set any such rows back to 'expired' first.)
CREATE TABLE "payer_capacity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"max_active_vacancies" integer NOT NULL,
	"source_tier" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_capacity_max_nonneg_chk" CHECK ("payer_capacity"."max_active_vacancies" >= 0)
);
--> statement-breakpoint
ALTER TABLE "posting_plans" DROP CONSTRAINT "posting_plans_status_chk";--> statement-breakpoint
CREATE UNIQUE INDEX "payer_capacity_payer_id_uq" ON "payer_capacity" USING btree ("payer_id");--> statement-breakpoint
ALTER TABLE "posting_plans" ADD CONSTRAINT "posting_plans_status_chk" CHECK ("posting_plans"."status" IN ('draft', 'active', 'expired', 'paused'));--> statement-breakpoint
-- Spine-wide RLS + REVOKE (TD20) for payer_capacity, applied in the SAME migration that
-- creates it (never reachable via the PostgREST Data API even briefly), so the rls-spine
-- no-drift + REVOKE-ALL regression passes. PII-FREE & faceless (opaque payer_id, no FK),
-- but locked for consistency + no-drift; the backend connects directly as postgres
-- (BYPASSRLS) and is unaffected. Mirrors the ADR-0013 monetization tables (migration 0016).
ALTER TABLE "payer_capacity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_capacity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capacity" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capacity" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capacity" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_capacity" FROM service_role;
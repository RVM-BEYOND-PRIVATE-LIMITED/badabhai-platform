-- Matching V1 — step 1 of 7: the MATCH VOCABULARY.
--
-- EXPAND-ONLY. Nothing is dropped, renamed, or made NOT NULL without a DEFAULT. No
-- shipped column changes meaning: the two new `skill` columns are NOT NULL WITH a
-- DEFAULT, so on Postgres 11+ each ADD COLUMN is a catalog-only change (no table
-- rewrite, no long lock) and every existing row reads back as
-- ('attribute', 'ind_industrial_manufacturing') — which is exactly what it already was.
--
--   * skill.kind        — 'match_skill' (the closed mskill_* matchable vocabulary) vs
--                         'attribute' (everything the pre-V1 vocabulary held).
--   * skill.industry_id — industry scope; matching never crosses industries.
--   * skill_related     — TIER-2 adjacency. Both directions are stored as two rows;
--                         SYMMETRY IS ENFORCED BY THE SEEDER + verify script, NOT by a
--                         DB trigger (see the schema.ts comment for why).
--
-- LOCKS: the two ADD COLUMNs are metadata-only. `ADD CONSTRAINT ... CHECK` takes an
-- ACCESS EXCLUSIVE lock on `skill` and validates every row — `skill` is small
-- reference data (hundreds of rows), so this is sub-second. If `skill` were ever large,
-- the split would be ADD CONSTRAINT ... NOT VALID; then VALIDATE CONSTRAINT.
--
-- ROLLBACK (fully reversible — no data is destroyed, nothing reads these yet):
--   DROP TABLE "skill_related";
--   DROP INDEX IF EXISTS "skill_industry_kind_idx";
--   ALTER TABLE "skill" DROP CONSTRAINT IF EXISTS "skill_kind_chk";
--   ALTER TABLE "skill" DROP COLUMN IF EXISTS "kind";
--   ALTER TABLE "skill" DROP COLUMN IF EXISTS "industry_id";
-- Dropping `kind`/`industry_id` loses only the D1 seeder's classification, which D1
-- re-derives from @badabhai/taxonomy on a re-run. Safe to roll back at any time BEFORE
-- 0053+ land (worker_skill/job_reach carry FKs into `skill`, not into these columns, so
-- even then the rollback is legal — it just makes the match engine fail closed).
CREATE TABLE "skill_related" (
	"skill_id" text NOT NULL,
	"related_skill_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_related_skill_id_related_skill_id_pk" PRIMARY KEY("skill_id","related_skill_id"),
	CONSTRAINT "skill_related_no_self_chk" CHECK ("skill_related"."skill_id" <> "skill_related"."related_skill_id")
);
--> statement-breakpoint
ALTER TABLE "skill_related" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "kind" text DEFAULT 'attribute' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "industry_id" text DEFAULT 'ind_industrial_manufacturing' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_related" ADD CONSTRAINT "skill_related_skill_id_skill_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_related" ADD CONSTRAINT "skill_related_related_skill_id_skill_skill_id_fk" FOREIGN KEY ("related_skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_related_related_skill_id_idx" ON "skill_related" USING btree ("related_skill_id");--> statement-breakpoint
CREATE INDEX "skill_industry_kind_idx" ON "skill" USING btree ("industry_id","kind");--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_kind_chk" CHECK ("skill"."kind" IN ('match_skill', 'attribute'));--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20): FORCE RLS + REVOKE ALL for every Data-API role on
-- the new table. drizzle-kit emits ENABLE only (above); FORCE + REVOKE are hand-appended
-- exactly as 0037 (skill/skill_alias/unresolved_phrase), 0048 and 0050 carried them. No
-- policies exist, so with FORCE the table is deny-by-default for every client-facing
-- role; the backend reaches it with the service-role (BYPASSRLS) connection.
-- `skill_related` is registered in tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "skill_related" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_related" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_related" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_related" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_related" FROM service_role;
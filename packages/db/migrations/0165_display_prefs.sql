-- ==============================================================================
-- 0165 - display_prefs: one login's display preference, today the theme (#2819)
-- ==============================================================================
--
-- Additive. One new table; no existing table, column, constraint or row is touched.
--   * display_prefs - the theme a login chose (light / dark / system), so it follows the person
--     across devices and between the web portal and the app. One row per
--     (subject_kind, subject_id): 'worker' (workers.id), 'payer_user' (payers.id, the LOGIN,
--     never the tenant key: a personal preference, so two teammates keep two themes) or 'admin'
--     (admin_users.id). theme defaults to 'light'; NO ROW ALSO MEANS 'light'.
--   NO FOREIGN KEY, on purpose: subject_id names a row in one of three tables, so no single FK
--   fits. No cascade erases a row, and NO ERASURE PATH NAMES THE TABLE YET (#2837, risk R88):
--   naming it in the worker's hard delete before this file is applied would roll every worker
--   erasure back on 42P01. A row whose login is gone matches nobody (ids are never reused) and
--   holds an opaque id and a theme only.
--   RLS ENABLE + hand-appended FORCE + four REVOKEs, no policy.
--
-- PREFLIGHT: none. A new table, so there are no existing rows to validate.
--
-- APPLY-BEFORE-PILOT, NOT APPLY-BEFORE-MERGE OR -DEPLOY. Only DisplayPrefsRepository names the
-- table, and DisplayPrefsService calls it only for a login the THEME_ROLLOUT switch is open for
-- (`pilot` and listed, or `on`). With the switch off (the default) nothing reads or writes it:
-- every GET answers light / theme_open false and every PATCH a plain 404. Open before this
-- migration, a read or a write fails with 42P01 (a missing column, 42703, the same) and the
-- service fails closed: GET answers light / theme_open false, PATCH 404, and the log carries the
-- ids and the SQLSTATE only. Nothing returns 500. Order:
--   1. Merge. The deploy is safe on a database without this table.
--   2. LEDGER PRE-CHECK: `npx tsx adopt-migrations.ts` verify-only, no --only. Adopting 0165
--      moves the watermark past every lower unrecorded entry, which `db:migrate` then skips
--      forever; confirm everything up to 0164 is live first (0164 is apply-before-pilot too).
--   3. Apply this file by hand in one transaction (it takes no lock on a live table: no FK).
--   4. Adopt the ledger row from main's tree: `npx tsx adopt-migrations.ts --only
--      0165_display_prefs --apply --expect-host <HOST>`, then `pnpm db:audit:schema-contract`
--      (its 0165 rls entry reads MISSING until step 3).
--   5. Only then add pilot rows and set THEME_ROLLOUT to pilot (docs/environment-variables.md).
--
-- LOCKS. None on a live table: CREATE TABLE of a new name, no foreign key, no index beyond the
-- primary key.
--
-- ROLLBACK. The switch is the rollback for the feature: THEME_ROLLOUT=off, then redeploy; every
-- app is back on light at its next load and the stored choices wait. The table can be dropped
-- whatever the switch says (open, every read then fails closed); it loses every stored choice:
--   BEGIN;
--   DROP TABLE IF EXISTS "display_prefs";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794729354323;
--   COMMIT;
-- In the same code change, remove the table from LOCKED_TABLES in
-- tests/e2e/rls-spine.e2e.test.ts and the 0165 entry from schema-contract.ts.
-- ==============================================================================
CREATE TABLE "display_prefs" (
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"theme" text DEFAULT 'light' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "display_prefs_pk" PRIMARY KEY("subject_kind","subject_id"),
	CONSTRAINT "display_prefs_subject_kind_chk" CHECK ("display_prefs"."subject_kind" IN ('worker', 'payer_user', 'admin')),
	CONSTRAINT "display_prefs_theme_chk" CHECK ("display_prefs"."theme" IN ('light', 'dark', 'system'))
);
--> statement-breakpoint
ALTER TABLE "display_prefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0162 / 0163 / 0164 pattern), because a regenerate drops
-- them silently.
-- ===========================================================================
ALTER TABLE "display_prefs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "display_prefs" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "display_prefs" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "display_prefs" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "display_prefs" FROM service_role;

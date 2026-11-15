-- ==============================================================================
-- 0164 - feature_pilot_subjects: the pilot list for workers and admins (#2820)
-- ==============================================================================
--
-- Additive. One new table; no existing table, column, constraint or row is touched.
--   * feature_pilot_subjects - which workers and admin users a feature in `pilot` is open to,
--     one row per (feature, subject_kind, subject_id). THEME_ROLLOUT (#2820) is its first
--     reader. Companies stay on feature_pilot_payers (0162), keyed by tenant, so a team member
--     still inherits the company's place; this table never lists a company.
--     subject_kind is 'worker' (subject_id = workers.id) or 'admin' (admin_users.id).
--     added_by and reason on every row, with feature_pilot_payers' CHECKs.
--   NO FOREIGN KEY, on purpose: one column names a row in one of two tables, and a pilot row
--   must never block deleting a worker (a DPDP erasure) or an admin. A row whose login is gone
--   matches nobody, because ids are never reused; reason must not name the person.
--   RLS ENABLE + hand-appended FORCE + four REVOKEs, no policy.
--
-- PREFLIGHT: none. A new table, so there are no existing rows to validate.
--
-- APPLY-BEFORE-PILOT, NOT APPLY-BEFORE-MERGE OR -DEPLOY. Only FeaturePilotSubjectsRepository names
-- the table, and FeatureRolloutService calls it only for a worker or an admin while a switch reads
-- `pilot`. With THEME_ROLLOUT off (the default) or on, nothing reads it. In `pilot` before this
-- migration, the read fails with 42P01 and the service answers "not listed" (fails closed, logs
-- sqlstate and ids only): piloted workers and admins see the default theme, companies are
-- unaffected, and nothing returns 500. Order:
--   1. Merge. The deploy is safe on a database without this table.
--   2. LEDGER PRE-CHECK: adopt 0161, 0162 and 0163 FIRST. Their objects are live in production
--      but their ledger rows are still pending (#2752's adoption step). Run
--      `npx tsx adopt-migrations.ts` verify-only, no --only, and adopt each of them (and anything
--      else it reports unrecorded below 0164) before this one. Adopting 0164 moves the watermark
--      past every lower unrecorded entry, which `db:migrate` then skips forever.
--   3. Apply this file by hand in one transaction (it takes no lock on a live table: no FK).
--   4. Adopt the ledger row from main's tree: `npx tsx adopt-migrations.ts --only
--      0164_feature_pilot_subjects --apply --expect-host <HOST>`, then
--      `pnpm db:audit:schema-contract` (its 0164 rls entry reads MISSING until step 3).
--   5. Only then add pilot rows and set THEME_ROLLOUT to pilot (docs/environment-variables.md).
--
-- LOCKS. None on a live table: CREATE TABLE of a new name, no foreign key, no index beyond the
-- primary key.
--
-- ROLLBACK. The switch is the rollback for the feature: THEME_ROLLOUT=off, then redeploy. The
-- table can be dropped whatever the switch says (in `pilot`, every worker and admin read then
-- fails closed); it loses every worker and admin pilot entry:
--   BEGIN;
--   DROP TABLE IF EXISTS "feature_pilot_subjects";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794726943864;
--   COMMIT;
-- In the same code change, remove the table from LOCKED_TABLES in
-- tests/e2e/rls-spine.e2e.test.ts and the 0164 entry from schema-contract.ts.
-- ==============================================================================
CREATE TABLE "feature_pilot_subjects" (
	"feature" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"added_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_pilot_subjects_pk" PRIMARY KEY("feature","subject_kind","subject_id"),
	CONSTRAINT "fps_feature_chk" CHECK ("feature_pilot_subjects"."feature" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "fps_subject_kind_chk" CHECK ("feature_pilot_subjects"."subject_kind" IN ('worker', 'admin')),
	CONSTRAINT "fps_added_by_chk" CHECK ("feature_pilot_subjects"."added_by" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "fps_reason_chk" CHECK (char_length("feature_pilot_subjects"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "feature_pilot_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0162 / 0163 pattern), because a regenerate drops them
-- silently.
-- ===========================================================================
ALTER TABLE "feature_pilot_subjects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_subjects" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_subjects" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_subjects" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_subjects" FROM service_role;

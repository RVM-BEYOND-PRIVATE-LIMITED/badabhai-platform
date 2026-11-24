-- ===========================================================================
-- 0198 - the per-trade release switch (#3002, trades v2)
-- ===========================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- Standing rule: everything ships switched off. 60 trades arrive in three waves, some held for
-- a trade reviewer's sign-off, so each trade gets a switch the owner flips without a release.
--   - `trade_release`: one row per RELEASED trade (`role_kind` is the key, the same 63 declared
--     kinds as the 0196/0197 CHECKs). `posting_enabled` gates the posting catalogue and posting
--     validation (#3005, #3006); `form_enabled` gates the trade-form hand-over. A kind with NO
--     row reads as off everywhere. `updated_by` is the admin's id (or null for the seed); a row
--     is never deleted, switching off is an UPDATE.
--
-- ADDITIVE at the table level. One new table; no existing column, constraint or row moves. The
-- seed below inserts the 16 live posting kinds with `posting_enabled = true`, so behaviour on
-- the day of deploy is exactly today's; every other kind has no row and reads as off.
--
-- DEPLOY ORDER - APPLY BEFORE THE READERS, NOT BEFORE THE DEPLOY. No shipped reader names this
-- table yet (the posting catalogue, posting validation and the Campus translation target are
-- wired in #3005, #3006 and #3014); the admin route and `TradeReleaseService` fail closed on a
-- missing table (a read error answers off and logs the kind; the admin write answers 503), so
-- a deploy ahead of the migration breaks no request. Apply this before #3005/#3006/#3014 land.
--
-- LOCKS. The table is new and the seed is 16 rows. Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout (55P03).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0181 pattern) - a regenerate drops them. Registered as `0198-trade-release-rls` in
-- `schema-contract.ts` and listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch every enabled trade off first is meaningless — absence reads as off — so just
-- drop; every trade reads as off until the table is back and the seed re-applied):
--   DROP TABLE "trade_release";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE + seed). Apply once.
-- ===========================================================================
CREATE TABLE "trade_release" (
	"role_kind" text PRIMARY KEY NOT NULL,
	"posting_enabled" boolean DEFAULT false NOT NULL,
	"form_enabled" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_release_role_kind_chk" CHECK ("trade_release"."role_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator', 'heat_treatment_technician', 'production_supervisor', 'foundry_forging_operator', 'gear_cutting_operator', 'boring_machine_operator', 'spm_finishing_operator', 'cnc_router_operator', 'fabricator', 'tube_bending_operator', 'foundry_operator', 'die_casting_operator', 'forging_operator', 'plating_operator', 'plastic_extrusion_operator', 'cmm_operator', 'ndt_technician', 'calibration_technician', 'material_lab_technician', 'quality_engineer', 'robot_operator_programmer', 'instrumentation_technician', 'hvac_rac_technician', 'utility_operator', 'maintenance_engineer', 'service_engineer', 'production_engineer', 'process_engineer', 'npd_engineer', 'safety_officer', 'project_site_engineer', 'technical_sales_engineer', 'ppc_engineer', 'store_keeper', 'purchase_engineer', 'dispatch_logistics_executive', 'forklift_operator', 'crane_operator', 'cae_analyst', 'piping_designer'))
);
--> statement-breakpoint
ALTER TABLE "trade_release" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "trade_release" ("role_kind", "posting_enabled", "form_enabled") VALUES
	('cnc_turner', true, false),
	('vmc_milling', true, false),
	('cnc_grinding', true, false),
	('cam_programmer', true, false),
	('cad_draughtsman', true, false),
	('conventional_machinist', true, false),
	('tool_die_maker', true, false),
	('welder', true, false),
	('sheet_metal_worker', true, false),
	('press_operator', true, false),
	('painter_coating', true, false),
	('fitter', true, false),
	('maintenance_technician', true, false),
	('industrial_electrician', true, false),
	('assembly_line_worker', true, false),
	('quality_inspector', true, false);
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0181 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "trade_release" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "trade_release" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "trade_release" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "trade_release" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "trade_release" FROM service_role;

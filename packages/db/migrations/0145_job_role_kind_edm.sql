-- ===========================================================================
-- 0145 - widen role_kind CHECKs with the 24th declared kind (CEO Launch Plan
-- Pack v1, Phase 2 #7: EDM / Wire-cut Operator)
--
-- PURELY ADDITIVE at the vocabulary level: DROP + ADD of the two NULL-tolerant
-- CHECKs, each re-closing the same list plus 'edm_wirecut_operator'. No
-- column is added, dropped or rewritten; no backfill. Same shape as 0139 and 0142. The
-- model-level tripwire in `migration-0131-job-role-kind.test.ts` reads the
-- drizzle model and stays red until both constraints name the new kind.
--
-- PRIVACY: a closed enum of occupation slugs. No employer identity, no worker identity.
--
-- APPLY-BEFORE-DEPLOY. The payer portal renders the role picker from
-- `JOB_ROLE_LABELS` (which gains `edm_wirecut_operator` in the same
-- change), so a build carrying the new label against a database without the
-- widened CHECK 500s the posting the moment a payer picks the new role. An OLD
-- build on a migrated database is fine (a superset). No new schema-contract
-- entries: the checked objects are the 0131 ones, already registered.
--
-- LOCKS. Each validated `ADD CONSTRAINT ... CHECK` takes ACCESS EXCLUSIVE and
-- scans its table; over a mostly-NULL `role_kind` column on small tables the
-- scan is milliseconds. Wrap all four statements in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03.
--
-- ROLLBACK. A CODE rollback needs no schema change. A schema rollback REJECTS
-- every stored 'edm_wirecut_operator' pick, so only on a database where
--   SELECT (SELECT count(*) FROM "job_postings" WHERE "role_kind" = 'edm_wirecut_operator')
--        + (SELECT count(*) FROM "jobs" WHERE "role_kind" = 'edm_wirecut_operator');   -- expect 0
-- and only AFTER the code that names the kind is rolled back: re-run the 0142
-- file's two DROP + ADD CONSTRAINT pairs to restore the 23-kind lists.
-- ===========================================================================
ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_role_kind_chk";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_role_kind_chk";--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_role_kind_chk" CHECK ("job_postings"."role_kind" IS NULL OR "job_postings"."role_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_role_kind_chk" CHECK ("jobs"."role_kind" IS NULL OR "jobs"."role_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator'));
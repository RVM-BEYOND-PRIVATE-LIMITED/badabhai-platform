-- ===========================================================================
-- 0146 - widen the two worker_resume_import role-kind CHECKs with the 24th
-- declared kind (EDM / Wire-cut Operator, CEO Launch Plan Pack v1 Phase 2 #7).
--
-- PURELY ADDITIVE at the vocabulary level: DROP + ADD both CHECKs, each
-- re-closing the same list plus 'edm_wirecut_operator'. No column is
-- added, dropped or rewritten; no backfill. Same shape as 0140 and 0143. The model-level
-- tripwire in `migration-0124-resume-identity-role-kind.test.ts` reads the
-- drizzle model and turns red until it does.
--
-- PRIVACY: a closed enum of occupation slugs. No employer identity, no worker identity.
--
-- APPLY-BEFORE-DEPLOY. A chat-profiled EDM operator resolves his identity
-- role to `edm_wirecut_operator` and `saveIdentitySummary` writes it;
-- against a database without the widened CHECKs that write 23514s and the
-- staged line is lost on every retry (the #1693 shape). An OLD build on a
-- migrated database is fine (a superset).
--
-- LOCKS. As 0145: one transaction with `SET LOCAL lock_timeout = '3s'`,
-- retry on 55P03; the table is small and the predicate trivially true.
--
-- ROLLBACK. A CODE rollback needs no schema change. A schema rollback REJECTS
-- every stored 'edm_wirecut_operator' pick, so only on a database where
--   SELECT (SELECT count(*) FROM "worker_resume_import" WHERE "association_kind" = 'edm_wirecut_operator')
--        + (SELECT count(*) FROM "worker_resume_import" WHERE "identity_role_kind" = 'edm_wirecut_operator');   -- expect 0
-- and only AFTER the code that names the kind is rolled back: re-run the 0143
-- file's DROP + ADD CONSTRAINT statements to restore the 23-kind lists.
-- ===========================================================================
ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_association_kind_chk";--> statement-breakpoint
ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_identity_role_kind_chk";--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_association_kind_chk" CHECK ("worker_resume_import"."association_kind" IS NULL OR "worker_resume_import"."association_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator'));--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_identity_role_kind_chk" CHECK ("worker_resume_import"."identity_role_kind" IS NULL OR "worker_resume_import"."identity_role_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator'));
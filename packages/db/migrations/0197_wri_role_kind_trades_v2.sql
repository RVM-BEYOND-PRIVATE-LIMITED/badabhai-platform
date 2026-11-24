-- ===========================================================================
-- 0197 - widen the two worker_resume_import role-kind CHECKs to the 63 declared
-- kinds (CEO pack v2, #2999: the 36 new trades of the 60-trade catalogue).
--
-- PURELY ADDITIVE at the vocabulary level: DROP + ADD both CHECKs, each re-closing
-- the same 27-kind list plus the 36 new kinds. No column is added, dropped or
-- rewritten; no backfill. Same shape as 0152. The model-level tripwire in
-- `migration-0124-resume-identity-role-kind.test.ts` reads the drizzle model and
-- turns red until both constraints name all 63.
--
-- PRIVACY: a closed enum of occupation slugs. No employer identity, no worker identity.
--
-- APPLY-BEFORE-DEPLOY. A chat-profiled worker whose trade is one of the 36 new kinds
-- resolves his identity role to it and `saveIdentitySummary` writes it; against a
-- database without the widened CHECKs that write 23514s and the staged line is lost
-- on every retry (the #1693 shape). An OLD build on a migrated database is fine
-- (a superset).
--
-- LOCKS. As 0196: one transaction with `SET LOCAL lock_timeout = '3s'`, retry on
-- 55P03; the table is small and the predicate trivially true.
--
-- ROLLBACK. A CODE rollback needs no schema change. A schema rollback REJECTS every
-- stored pick of a new kind, so only on a database where
--   SELECT (SELECT count(*) FROM "worker_resume_import" WHERE "association_kind" IN (...36 new...))
--        + (SELECT count(*) FROM "worker_resume_import" WHERE "identity_role_kind" IN (...36 new...));   -- expect 0
-- and only AFTER the code that names the kinds is rolled back: re-run the 0152
-- file's DROP + ADD CONSTRAINT statements to restore the 27-kind lists.
-- ===========================================================================
ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_association_kind_chk";--> statement-breakpoint
ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_identity_role_kind_chk";--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_association_kind_chk" CHECK ("worker_resume_import"."association_kind" IS NULL OR "worker_resume_import"."association_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator', 'heat_treatment_technician', 'production_supervisor', 'foundry_forging_operator', 'gear_cutting_operator', 'boring_machine_operator', 'spm_finishing_operator', 'cnc_router_operator', 'fabricator', 'tube_bending_operator', 'foundry_operator', 'die_casting_operator', 'forging_operator', 'plating_operator', 'plastic_extrusion_operator', 'cmm_operator', 'ndt_technician', 'calibration_technician', 'material_lab_technician', 'quality_engineer', 'robot_operator_programmer', 'instrumentation_technician', 'hvac_rac_technician', 'utility_operator', 'maintenance_engineer', 'service_engineer', 'production_engineer', 'process_engineer', 'npd_engineer', 'safety_officer', 'project_site_engineer', 'technical_sales_engineer', 'ppc_engineer', 'store_keeper', 'purchase_engineer', 'dispatch_logistics_executive', 'forklift_operator', 'crane_operator', 'cae_analyst', 'piping_designer'));--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_identity_role_kind_chk" CHECK ("worker_resume_import"."identity_role_kind" IS NULL OR "worker_resume_import"."identity_role_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator', 'heat_treatment_technician', 'production_supervisor', 'foundry_forging_operator', 'gear_cutting_operator', 'boring_machine_operator', 'spm_finishing_operator', 'cnc_router_operator', 'fabricator', 'tube_bending_operator', 'foundry_operator', 'die_casting_operator', 'forging_operator', 'plating_operator', 'plastic_extrusion_operator', 'cmm_operator', 'ndt_technician', 'calibration_technician', 'material_lab_technician', 'quality_engineer', 'robot_operator_programmer', 'instrumentation_technician', 'hvac_rac_technician', 'utility_operator', 'maintenance_engineer', 'service_engineer', 'production_engineer', 'process_engineer', 'npd_engineer', 'safety_officer', 'project_site_engineer', 'technical_sales_engineer', 'ppc_engineer', 'store_keeper', 'purchase_engineer', 'dispatch_logistics_executive', 'forklift_operator', 'crane_operator', 'cae_analyst', 'piping_designer'));
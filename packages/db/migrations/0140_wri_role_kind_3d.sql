-- ===========================================================================
-- 0140 - widen the two worker_resume_import role-kind CHECKs with the 22nd
-- declared kind (3D CAD Designer, CEO Launch Plan Pack v1 Track A #4).
--
-- PURELY ADDITIVE at the vocabulary level: DROP + ADD both CHECKs, each
-- re-closing the same list plus 'cad_designer_3d'. No column is added, dropped
-- or rewritten; no backfill. The model-level tripwire in
-- `migration-0124-resume-identity-role-kind.test.ts` reads the drizzle model
-- and turns red until it does.
--
-- PRIVACY: a closed enum of occupation slugs. No employer identity, no worker identity.
--
-- APPLY-BEFORE-DEPLOY. A chat-profiled 3D designer resolves his identity role to
-- `cad_designer_3d` and `saveIdentitySummary` writes it; against a database
-- without the widened CHECKs that write 23514s and the staged line is lost on
-- every retry (the #1693 shape). An OLD build on a migrated database is fine (a
-- superset). No new schema-contract entries: the checked objects are the 0124
-- ones, already registered — this migration only widens their definitions.
--
-- LOCKS. Each validated `ADD CONSTRAINT ... CHECK` takes ACCESS EXCLUSIVE and
-- scans its table under it; `worker_resume_import` is small and the predicate
-- over a mostly-NULL column is trivially true, so the scan is milliseconds.
-- Same queueing caution as 0139: wrap all four statements in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03.
-- `db:migrate` applies every pending file in one transaction, so set a session
-- `lock_timeout` there too.
--
-- ROLLBACK. A CODE rollback needs no schema change. A schema rollback REJECTS
-- every stored 'cad_designer_3d' pick, so only on a database where
--   SELECT (SELECT count(*) FROM "worker_resume_import" WHERE "association_kind" = 'cad_designer_3d')
--        + (SELECT count(*) FROM "worker_resume_import" WHERE "identity_role_kind" = 'cad_designer_3d');   -- expect 0
-- and only AFTER the code that names the kind is rolled back:
--   ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_association_kind_chk";
--   ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_identity_role_kind_chk";
--   -- then re-run the 0124 file's two ADD CONSTRAINT statements to restore the 21-kind lists.
-- ===========================================================================
ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_association_kind_chk";--> statement-breakpoint
ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_identity_role_kind_chk";--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_association_kind_chk" CHECK ("worker_resume_import"."association_kind" IS NULL OR "worker_resume_import"."association_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d'));--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_identity_role_kind_chk" CHECK ("worker_resume_import"."identity_role_kind" IS NULL OR "worker_resume_import"."identity_role_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d'));
ALTER TABLE "worker_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_profiles" DROP CONSTRAINT "worker_profiles_job_domain_match_status_chk";--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "job_domain_match_layer" text;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_job_domain_match_layer_chk" CHECK ("worker_profiles"."job_domain_match_layer" IS NULL OR (
        "worker_profiles"."job_domain_match_layer" IN ('l0_exact', 'l1_skeleton', 'l2_trigram', 'l3_vector')
        AND "worker_profiles"."job_domain_match_status" LIKE 'matched%'
      ));--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_job_domain_match_status_chk" CHECK ("worker_profiles"."job_domain_match_status" IS NULL OR "worker_profiles"."job_domain_match_status" IN ('matched_auto', 'matched_llm', 'unmatched_below_floor', 'unmatched_llm_declined', 'unmatched_degraded', 'matched_lexical', 'matched_worker_confirmed'));--> statement-breakpoint
-- HAND-APPENDED, mirroring 0066_special_pyro.sql's tail. `worker_profiles` was one of the
-- last worker tables without RLS — it holds the canonicalized profile of every worker on
-- the platform, so it is exactly the table the posture exists for. ENABLE above is
-- drizzle-modelled; FORCE and the revocations are not, and without FORCE the owner role
-- the backend connects as bypasses every policy.
ALTER TABLE "worker_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM service_role;
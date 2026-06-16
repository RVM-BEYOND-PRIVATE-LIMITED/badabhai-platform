CREATE TABLE "posting_boosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"tier" text DEFAULT 'all_candidates' NOT NULL,
	"boost_starts_at" timestamp with time zone,
	"boost_ends_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_boosts_tier_chk" CHECK ("posting_boosts"."tier" IN ('all_candidates')),
	CONSTRAINT "posting_boosts_status_chk" CHECK ("posting_boosts"."status" IN ('active', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "posting_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"applicant_visibility_quota" integer NOT NULL,
	"applicants_viewed_count" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_plans_tier_chk" CHECK ("posting_plans"."tier" IN ('standard', 'pro')),
	CONSTRAINT "posting_plans_status_chk" CHECK ("posting_plans"."status" IN ('draft', 'active', 'expired')),
	CONSTRAINT "posting_plans_viewed_nonneg_chk" CHECK ("posting_plans"."applicants_viewed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pricing_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_disclosures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"job_posting_id" uuid,
	"resume_ref" uuid,
	"status" text DEFAULT 'requested' NOT NULL,
	"deny_reason" text,
	"disclosed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_disclosures_deny_reason_chk" CHECK ("resume_disclosures"."deny_reason" IS NULL OR "resume_disclosures"."status" = 'denied')
);
--> statement-breakpoint
ALTER TABLE "posting_boosts" ADD CONSTRAINT "posting_boosts_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_plans" ADD CONSTRAINT "posting_plans_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ADD CONSTRAINT "resume_disclosures_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ADD CONSTRAINT "resume_disclosures_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ADD CONSTRAINT "resume_disclosures_resume_ref_generated_resumes_id_fk" FOREIGN KEY ("resume_ref") REFERENCES "public"."generated_resumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posting_boosts_job_posting_id_idx" ON "posting_boosts" USING btree ("job_posting_id");--> statement-breakpoint
CREATE INDEX "posting_boosts_payer_id_idx" ON "posting_boosts" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX "posting_plans_job_posting_id_idx" ON "posting_plans" USING btree ("job_posting_id");--> statement-breakpoint
CREATE INDEX "posting_plans_payer_id_idx" ON "posting_plans" USING btree ("payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_catalog_active_uq" ON "pricing_catalog" USING btree ("is_active") WHERE "pricing_catalog"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "resume_disclosures_payer_worker_posting_uq" ON "resume_disclosures" USING btree ("payer_id","worker_id","job_posting_id");--> statement-breakpoint
CREATE INDEX "resume_disclosures_worker_id_idx" ON "resume_disclosures" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "resume_disclosures_payer_id_idx" ON "resume_disclosures" USING btree ("payer_id");--> statement-breakpoint
-- Spine-wide RLS + REVOKE (TD20) for the four ADR-0013 monetization tables, applied
-- in the SAME migration that creates them (never reachable via the PostgREST Data API
-- even briefly), so the rls-spine no-drift + REVOKE-ALL regression passes. PII-FREE
-- tables, but locked for consistency + no-drift; the backend connects directly as
-- postgres (BYPASSRLS) and is unaffected. The only identity join is
-- resume_disclosures.worker_id -> workers (already locked).
ALTER TABLE "pricing_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing_catalog" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "pricing_catalog" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "pricing_catalog" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "pricing_catalog" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "pricing_catalog" FROM service_role;--> statement-breakpoint
ALTER TABLE "posting_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "posting_plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_plans" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_plans" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_plans" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_plans" FROM service_role;--> statement-breakpoint
ALTER TABLE "posting_boosts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "posting_boosts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_boosts" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_boosts" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_boosts" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "posting_boosts" FROM service_role;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resume_disclosures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "resume_disclosures" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "resume_disclosures" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "resume_disclosures" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "resume_disclosures" FROM service_role;
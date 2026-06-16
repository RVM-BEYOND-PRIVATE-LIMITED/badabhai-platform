CREATE TABLE "job_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"org_label" text NOT NULL,
	"role_title" text NOT NULL,
	"location_label" text,
	"description" text,
	"vacancy_band" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "job_postings_vacancy_band_chk" CHECK ("job_postings"."vacancy_band" IN ('1', '2-5', '6-10', '11-25', '25+')),
	CONSTRAINT "job_postings_status_chk" CHECK ("job_postings"."status" IN ('draft', 'open', 'closed'))
);
--> statement-breakpoint

-- Spine-wide RLS + REVOKE (TD20) for job_postings, applied in the SAME migration
-- that creates it (never reachable via the PostgREST Data API even briefly). #48
-- shipped the table without this lock; added during the merge reconciliation so the
-- rls-spine no-drift + REVOKE-ALL regression passes. Free text (org/role/location/
-- description) is NON-PII but the table is locked for consistency + no-drift; the
-- backend connects directly as postgres (BYPASSRLS) and is unaffected.
ALTER TABLE "job_postings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_postings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_postings" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_postings" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_postings" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_postings" FROM service_role;

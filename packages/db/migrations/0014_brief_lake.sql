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

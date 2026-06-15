CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"source_surface" text DEFAULT 'feed' NOT NULL,
	"rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_reason_chk" CHECK ("applications"."reason" IS NULL OR "applications"."action" = 'skipped')
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_key" text NOT NULL,
	"title" text NOT NULL,
	"city" text NOT NULL,
	"area" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_worker_job_uq" ON "applications" USING btree ("worker_id","job_id");--> statement-breakpoint
CREATE INDEX "applications_job_id_idx" ON "applications" USING btree ("job_id");--> statement-breakpoint

-- Spine-wide RLS + REVOKE (TD20) for the two new tables, applied in the SAME
-- migration that creates them so they are never reachable via the PostgREST Data
-- API even briefly. Same proven lock as 0009: ENABLE + FORCE RLS, then REVOKE ALL
-- from PUBLIC and the three client-facing roles (no policies -> deny by default for
-- every non-BYPASSRLS role). The backend connects directly as `postgres` (BYPASSRLS)
-- and is unaffected. `jobs` is PII-free catalog data (locked for consistency +
-- no-drift); `applications` carries a worker FK (linkable) and MUST be locked.
-- The anon/authenticated/service_role roles must exist for the REVOKEs to apply
-- (they do on Supabase; CI pre-creates them).

-- jobs
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "jobs" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "jobs" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "jobs" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "jobs" FROM service_role;--> statement-breakpoint

-- applications (carries a worker FK — linkable; must be locked)
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "applications" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "applications" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "applications" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "applications" FROM service_role;
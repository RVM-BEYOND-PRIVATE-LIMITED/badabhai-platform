CREATE TABLE "pace_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"stage" text DEFAULT 'base' NOT NULL,
	"wave" integer DEFAULT 0 NOT NULL,
	"current_area_km" integer,
	"last_supply_count" integer DEFAULT 0 NOT NULL,
	"ops_alert_raised" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pace_states_wave_nonneg_chk" CHECK ("pace_states"."wave" >= 0),
	CONSTRAINT "pace_states_supply_nonneg_chk" CHECK ("pace_states"."last_supply_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pace_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pace_states" ADD CONSTRAINT "pace_states_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pace_states_job_id_uq" ON "pace_states" USING btree ("job_id");--> statement-breakpoint
-- Spine posture (TD20): FORCE RLS + REVOKE all Data-API roles. pace_states is PII-free
-- but linkable (opaque job_id), so it denies anon/authenticated/service_role like the
-- rest of the spine; the backend postgres/BYPASSRLS role is unaffected.
ALTER TABLE "pace_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "pace_states" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "pace_states" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "pace_states" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "pace_states" FROM service_role;
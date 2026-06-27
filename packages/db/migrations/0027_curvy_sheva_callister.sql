CREATE TABLE "worker_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"flag_reason_code" text NOT NULL,
	"flagged_by_admin_id" uuid NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_flags_reason_code_chk" CHECK ("worker_flags"."flag_reason_code" IN ('quality_review', 'abuse_report', 'duplicate', 'other'))
);
--> statement-breakpoint
ALTER TABLE "worker_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_flags" ADD CONSTRAINT "worker_flags_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_flags_worker_id_idx" ON "worker_flags" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_flags_open_uq" ON "worker_flags" USING btree ("worker_id") WHERE "worker_flags"."resolved_at" IS NULL;--> statement-breakpoint
-- Spine posture (ADR-0004 / ADR-0025 / TD20): FORCE RLS + REVOKE all Data-API roles.
-- worker_flags is faceless metadata (ids + a reason CODE + timestamps; NO PII), but it
-- carries an admin-side handle onto a worker (`worker_id`), so it denies
-- anon/authenticated/service_role like the rest of the spine (drizzle-kit emits ENABLE
-- only; FORCE + REVOKE are appended here, the same way 0026_admin_users /
-- 0025_agency_invites / 0023_pace_states / 0009_spine_rls_revoke carried them). Only the
-- backend postgres/BYPASSRLS role reaches this table; the AdminAuthGuard + RBAC is the
-- app-layer access control for the flag/unflag action.
ALTER TABLE "worker_flags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_flags" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_flags" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_flags" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_flags" FROM service_role;
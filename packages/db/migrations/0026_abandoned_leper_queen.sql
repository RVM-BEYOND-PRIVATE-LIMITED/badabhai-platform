CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_enc" text NOT NULL,
	"email_hash" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mfa_enrolled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_role_chk" CHECK ("admin_users"."role" IN ('super_admin', 'ops_admin', 'support', 'analyst')),
	CONSTRAINT "admin_users_status_chk" CHECK ("admin_users"."status" IN ('pending', 'active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "admin_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_hash_uq" ON "admin_users" USING btree ("email_hash");--> statement-breakpoint
-- Spine posture (ADR-0004 / ADR-0025): FORCE RLS + REVOKE all Data-API roles.
-- admin_users holds ADMIN-CLASS PII (the admin's own email, encrypted) + authz state,
-- so it is locked at least as tightly as workers/payers/the spine: it denies
-- anon/authenticated/service_role outright (drizzle-kit emits ENABLE only; FORCE +
-- REVOKE are appended here the same way 0023_pace_states / 0025_agency_invites /
-- 0009_spine_rls_revoke / 0016 carried them). Only the backend postgres/BYPASSRLS
-- role reaches this table; the AdminAuthGuard is the app-layer access control.
ALTER TABLE "admin_users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "admin_users" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "admin_users" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "admin_users" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "admin_users" FROM service_role;
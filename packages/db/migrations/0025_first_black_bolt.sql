CREATE TABLE "agency_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_payer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"invited_worker_id" uuid,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agency_invites" ADD CONSTRAINT "agency_invites_inviter_payer_id_payers_id_fk" FOREIGN KEY ("inviter_payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_invites" ADD CONSTRAINT "agency_invites_invited_worker_id_workers_id_fk" FOREIGN KEY ("invited_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_invites_code_uq" ON "agency_invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "agency_invites_inviter_payer_id_idx" ON "agency_invites" USING btree ("inviter_payer_id");--> statement-breakpoint
CREATE INDEX "agency_invites_invited_worker_id_idx" ON "agency_invites" USING btree ("invited_worker_id");--> statement-breakpoint
-- Spine posture (ADR-0022 Appendix C #3): FORCE RLS + REVOKE all Data-API roles.
-- agency_invites is faceless/ids-only, but `invited_worker_id` is a NEW payer-side
-- handle onto a worker — so it denies anon/authenticated/service_role like the rest
-- of the spine (drizzle-kit emits ENABLE only; FORCE + REVOKE are appended here, the
-- same way 0023_pace_states / 0009_spine_rls_revoke / 0016 carried them). Phase-1
-- isolation is the app-layer chokepoint (assertPayerOwns on inviter_payer_id);
-- DB-enforced per-payer RLS is the open-GA launch gate (infra/supabase/rls-plan.md).
-- The backend connects as the postgres/BYPASSRLS role and is unaffected.
ALTER TABLE "agency_invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_invites" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_invites" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_invites" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_invites" FROM service_role;
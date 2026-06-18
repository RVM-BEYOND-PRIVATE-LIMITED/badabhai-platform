CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"inviter_worker_id" uuid NOT NULL,
	"invited_worker_id" uuid,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_worker_id_workers_id_fk" FOREIGN KEY ("inviter_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_worker_id_workers_id_fk" FOREIGN KEY ("invited_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_code_uq" ON "invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "invites_inviter_worker_id_idx" ON "invites" USING btree ("inviter_worker_id");--> statement-breakpoint
-- Spine RLS posture (TD20): FORCE + REVOKE all client-facing roles so only the
-- BYPASSRLS backend reads invites via a direct connection (never the Data API).
-- Invites are PII-free (opaque ids), but they link to workers — locked for consistency.
ALTER TABLE "invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "invites" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "invites" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "invites" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "invites" FROM service_role;
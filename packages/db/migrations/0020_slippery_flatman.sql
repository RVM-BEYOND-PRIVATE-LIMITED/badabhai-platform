CREATE TABLE "payers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"email_enc" text NOT NULL,
	"email_hash" text NOT NULL,
	"phone_enc" text,
	"phone_hash" text,
	"org_name_enc" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "payers_email_hash_uq" ON "payers" USING btree ("email_hash");--> statement-breakpoint
-- ADR-0004 lock for the new payer-PII table: FORCE RLS + REVOKE all client-facing
-- roles (deny-by-default; only the BYPASSRLS backend `postgres` role reads it via a
-- direct connection, never the PostgREST Data API). Mirrors workers 0003/0004 +
-- the spine 0009. Payer/employer B2B PII (ADR-0019 B-R2) gets the same posture as
-- worker PII. Idempotent; the client roles must exist (Supabase + CI precondition).
ALTER TABLE "payers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payers" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payers" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payers" FROM service_role;
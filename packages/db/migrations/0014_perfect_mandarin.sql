CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"unlock_id" uuid,
	"pack_code" text,
	"payment_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payer_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_credits_balance_nonneg_chk" CHECK ("payer_credits"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "unlock_routing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unlock_id" uuid NOT NULL,
	"routing_token" uuid NOT NULL,
	"channel" text NOT NULL,
	"relay_handle" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unlocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"job_id" uuid,
	"status" text DEFAULT 'requested' NOT NULL,
	"deny_reason" text,
	"routing_token_ref" uuid,
	"reveal_count" integer DEFAULT 0 NOT NULL,
	"granted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unlocks_deny_reason_chk" CHECK ("unlocks"."deny_reason" IS NULL OR "unlocks"."status" = 'denied')
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payer_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_unlock_id_unlocks_id_fk" FOREIGN KEY ("unlock_id") REFERENCES "public"."unlocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlock_routing" ADD CONSTRAINT "unlock_routing_unlock_id_unlocks_id_fk" FOREIGN KEY ("unlock_id") REFERENCES "public"."unlocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlocks" ADD CONSTRAINT "unlocks_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlocks" ADD CONSTRAINT "unlocks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_payer_id_idx" ON "credit_ledger" USING btree ("payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_credits_payer_id_uq" ON "payer_credits" USING btree ("payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unlock_routing_routing_token_uq" ON "unlock_routing" USING btree ("routing_token");--> statement-breakpoint
CREATE INDEX "unlock_routing_unlock_id_idx" ON "unlock_routing" USING btree ("unlock_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unlocks_payer_worker_uq" ON "unlocks" USING btree ("payer_id","worker_id");--> statement-breakpoint
CREATE INDEX "unlocks_worker_id_idx" ON "unlocks" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "unlocks_payer_id_idx" ON "unlocks" USING btree ("payer_id");--> statement-breakpoint

-- Spine-wide RLS + REVOKE (TD20) for the four new Contact Unlock tables (ADR-0010),
-- applied in the SAME migration that creates them so they are never reachable via
-- the PostgREST Data API even briefly. Same proven lock as 0012: ENABLE + FORCE RLS,
-- then REVOKE ALL from PUBLIC and the three client-facing roles (no policies -> deny
-- by default for every non-BYPASSRLS role). The backend connects directly as
-- `postgres` (BYPASSRLS) and is unaffected. `jobs.payer_id` is an ADDITIVE column on
-- the already-locked `jobs` table and needs no separate lock.
--
-- PRIVACY: none of these tables carry PII. `unlocks.worker_id` is the only join back
-- to identity (FK into the RLS-locked `workers`, where PII lives); `payer_id` is an
-- opaque faceless-rails ref; `unlock_routing` is phone-free by construction (the raw
-- phone is read transiently at reveal and NEVER stored). They are locked here because
-- they are linkable + for no-drift consistency with the rest of the spine.
-- The anon/authenticated/service_role roles must exist for the REVOKEs to apply
-- (they do on Supabase; CI pre-creates them).

-- unlocks (carries a worker FK — linkable; must be locked)
ALTER TABLE "unlocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unlocks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "unlocks" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "unlocks" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "unlocks" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "unlocks" FROM service_role;--> statement-breakpoint

-- payer_credits
ALTER TABLE "payer_credits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_credits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_credits" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_credits" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_credits" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_credits" FROM service_role;--> statement-breakpoint

-- credit_ledger
ALTER TABLE "credit_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_ledger" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_ledger" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_ledger" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_ledger" FROM service_role;--> statement-breakpoint

-- unlock_routing (server-side-only routing mapping; phone-free, but linkable — must be locked)
ALTER TABLE "unlock_routing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unlock_routing" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_routing" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_routing" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_routing" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_routing" FROM service_role;
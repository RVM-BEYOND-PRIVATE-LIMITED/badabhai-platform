CREATE TABLE "agency_kyc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"pan_enc" text NOT NULL,
	"pan_hash" text NOT NULL,
	"bank_account_enc" text NOT NULL,
	"ifsc_enc" text NOT NULL,
	"account_holder_name_enc" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_kyc_reject_reason_chk" CHECK ("agency_kyc"."reject_reason" IS NULL OR "agency_kyc"."status" = 'rejected')
);
--> statement-breakpoint
ALTER TABLE "agency_kyc" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agency_payout_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_payer_id" uuid NOT NULL,
	"source_unlock_id" uuid NOT NULL,
	"basis_inr" integer NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount_inr" integer NOT NULL,
	"unlock_granted_at" timestamp with time zone NOT NULL,
	"attributed_at" timestamp with time zone NOT NULL,
	"payout_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_payout_accruals_amount_nonneg_chk" CHECK ("agency_payout_accruals"."amount_inr" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agency_payout_accruals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agency_payout_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_payer_id" uuid NOT NULL,
	"amount_inr" integer NOT NULL,
	"accrual_count" integer NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"kyc_snapshot_status" text NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_payout_requests_amount_nonneg_chk" CHECK ("agency_payout_requests"."amount_inr" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agency_payout_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agency_invites" ADD COLUMN "attributed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency_kyc" ADD CONSTRAINT "agency_kyc_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_payout_accruals" ADD CONSTRAINT "agency_payout_accruals_agency_payer_id_payers_id_fk" FOREIGN KEY ("agency_payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_payout_accruals" ADD CONSTRAINT "agency_payout_accruals_source_unlock_id_unlocks_id_fk" FOREIGN KEY ("source_unlock_id") REFERENCES "public"."unlocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_payout_accruals" ADD CONSTRAINT "agency_payout_accruals_payout_request_id_agency_payout_requests_id_fk" FOREIGN KEY ("payout_request_id") REFERENCES "public"."agency_payout_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_payout_requests" ADD CONSTRAINT "agency_payout_requests_agency_payer_id_payers_id_fk" FOREIGN KEY ("agency_payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_kyc_payer_id_uq" ON "agency_kyc" USING btree ("payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_kyc_pan_hash_uq" ON "agency_kyc" USING btree ("pan_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_payout_accruals_source_unlock_id_uq" ON "agency_payout_accruals" USING btree ("source_unlock_id");--> statement-breakpoint
CREATE INDEX "agency_payout_accruals_agency_payer_id_idx" ON "agency_payout_accruals" USING btree ("agency_payer_id");--> statement-breakpoint
CREATE INDEX "agency_payout_accruals_payout_request_id_idx" ON "agency_payout_accruals" USING btree ("payout_request_id");--> statement-breakpoint
CREATE INDEX "agency_payout_requests_agency_payer_id_idx" ON "agency_payout_requests" USING btree ("agency_payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_payout_requests_idempotency_key_uq" ON "agency_payout_requests" USING btree ("idempotency_key");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0022 Amendment 2 / Appendix C #3): FORCE RLS + REVOKE all
-- Data-API roles for the three new agency supply-money tables. drizzle-kit emits
-- ENABLE only (above); FORCE + REVOKE are appended here the same way
-- 0025_agency_invites / 0023_pace_states / 0009_spine_rls_revoke / 0016 carried them.
-- `agency_kyc` holds HIGH-SENSITIVITY FINANCIAL PII (PAN/bank ciphertext) — workers-grade
-- at-rest discipline (ADR-0004): only the backend postgres/BYPASSRLS role touches these.
-- DB-enforced per-payer RLS policies are the open-GA launch gate (infra/supabase/rls-plan.md).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "agency_kyc" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM service_role;--> statement-breakpoint
ALTER TABLE "agency_payout_accruals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM service_role;--> statement-breakpoint
ALTER TABLE "agency_payout_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM service_role;
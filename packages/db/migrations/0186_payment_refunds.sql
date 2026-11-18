-- ==============================================================================
-- payment_refunds: admin refunds of real paid packs (#2750 item 10)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2750 item 10 (brief 4C.12, B4C-26, B4C-27). A super admin refunds one real Razorpay pack order
-- in full, under one of two rules: the pack is unused and within `refundUnusedWithinDays` (7) of its
-- purchase, or unused, within `refundLowMatchWithinDays` (30), and its job drew fewer than
-- `refundLowMatchMinWorkers` (3) applicants. ONE refund per order (`payment_refunds_order_uq`). The
-- pack's credits are removed (`pack_refund` ledger lines) in the transaction that writes the row,
-- before Razorpay is called; the row then follows the refund: requested, pending, processed or
-- failed (a failure is retried by an admin; the credits stay removed).
--
-- PII-FREE: ids, closed codes, integers, an opaque provider refund id and times. The admin's
-- written reason is on the `audit_logs` row, never here.
--
-- ADDITIVE ONLY. One new, EMPTY table, its indexes and two foreign keys; no existing column,
-- constraint or row moves. Nothing is seeded. `credit_ledger.reason` is plain text with no CHECK,
-- so `pack_refund` needs no DDL.
--
-- DEPLOY ORDER - APPLY BEFORE REFUNDS ARE TURNED ON, NOT BEFORE THE DEPLOY. Nothing names this
-- table until GST credit notes exist (owner ruling 2026-11-18): every refund route answers 503
-- first, and the refund webhook reads it only for a refund this code created. With the table
-- missing after credit notes arrive, the routes answer 503 and the webhook logs and acknowledges.
-- Apply every lower-numbered migration first (slot order), then this.
--
-- LOCKS. The new table is empty. The foreign keys take a brief SHARE ROW EXCLUSIVE lock on
-- `payment_orders` and `job_postings` (blocks their writes, not their reads, for the instant the
-- constraint is added; nothing to validate). Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 / 0185 pattern) - a regenerate drops them
-- silently. The table is registered as an `rls` entry in `schema-contract.ts` and listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (only while no refund exists; a refund row is a money record and is kept):
--   DROP TABLE IF EXISTS "payment_refunds";
-- ==============================================================================
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_order_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"job_posting_id" uuid,
	"applicants_counted" integer,
	"requested_by" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"credits_removed" integer NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"provider_refund_id" text,
	"failure_code" text,
	"credit_note_number" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_rule_chk" CHECK ("payment_refunds"."rule" IN ('unused', 'low_match')),
	CONSTRAINT "payment_refunds_status_chk" CHECK ("payment_refunds"."status" IN ('requested', 'pending', 'processed', 'failed')),
	CONSTRAINT "payment_refunds_failure_chk" CHECK (("payment_refunds"."status" = 'failed') = ("payment_refunds"."failure_code" IS NOT NULL) AND ("payment_refunds"."failure_code" IS NULL OR "payment_refunds"."failure_code" IN ('provider_error', 'provider_failed'))),
	CONSTRAINT "payment_refunds_amount_chk" CHECK ("payment_refunds"."amount_paise" > 0),
	CONSTRAINT "payment_refunds_credits_chk" CHECK ("payment_refunds"."credits_removed" >= 0),
	CONSTRAINT "payment_refunds_low_match_chk" CHECK (("payment_refunds"."rule" = 'low_match') = ("payment_refunds"."applicants_counted" IS NOT NULL)),
	CONSTRAINT "payment_refunds_processed_chk" CHECK (("payment_refunds"."status" = 'processed') = ("payment_refunds"."processed_at" IS NOT NULL) AND ("payment_refunds"."status" NOT IN ('pending', 'processed') OR "payment_refunds"."provider_refund_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "payment_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_order_id_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_order_uq" ON "payment_refunds" USING btree ("payment_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_provider_uq" ON "payment_refunds" USING btree ("provider_refund_id") WHERE "payment_refunds"."provider_refund_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_refunds_payer_idx" ON "payment_refunds" USING btree ("payer_id","requested_at" DESC NULLS LAST);

--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 / 0185 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "payment_refunds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_refunds" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_refunds" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_refunds" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_refunds" FROM service_role;

-- ==============================================================================
-- invoices: GST invoices and credit notes (#2749 part 4, items 8 and 9)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2749 items 8 and 9 (brief 4C.3; owner rulings 2026-11-18). Every captured real payment gets one
-- GST invoice, numbered in the settle's transaction; every refund gets one credit note, numbered in
-- the refund's transaction. Five new tables:
--   - `seller_tax_config`: the seller of record. Entered BY HAND after the merge (the repository is
--     public, so no GSTIN, PAN, name or address is in code). One active row; prefixes short enough
--     that a number fits Rule 46(b)'s 16 characters; the GSTIN's state and PAN must agree with the
--     row's own.
--   - `payer_billing_details`: a company's billing state and, optionally, GSTIN + legal name +
--     address (ciphertext under the same key as `payers.org_name_enc`). One row per tenant key.
--   - `invoice_number_series`: one gap-free counter per (series, financial year), incremented with
--     INSERT ... ON CONFLICT DO UPDATE inside the issuing transaction (a rollback releases it).
--   - `invoices`: one per paid order (unique), the seller and buyer snapshots, the tax lines in
--     paise (taxable + CGST + SGST + IGST = total; intra-state has no IGST, inter-state no CGST/SGST).
--   - `credit_notes`: one per refund (unique), the invoice's tax lines copied.
--
-- PII. The buyer's GSTIN, legal name and address are ciphertext (`*_enc`). The seller's are plain
-- (printed on every invoice) and never logged or emitted. No free text from a person.
--
-- ADDITIVE ONLY. Five new, EMPTY tables, their indexes and three foreign keys; no existing column,
-- constraint or row moves. Nothing is seeded (the seller row is the owner's hand step).
--
-- DEPLOY ORDER - APPLY BEFORE DEPLOY. The settle path writes an invoice in a SAVEPOINT (a missing
-- table never refuses money: the credits are granted and `payment.invoice_not_issued` is
-- recorded), but the payer routes `GET/PUT /payer/billing-details` and `GET /payer/invoices` name
-- these tables unconditionally, and the real checkout reads them before every new order (fails
-- closed: 503). Apply every lower-numbered migration first (slot order), then this, then deploy.
--
-- LOCKS. The new tables are empty. The foreign keys take a brief SHARE ROW EXCLUSIVE lock on
-- `payment_orders` and `payment_refunds` (blocks their writes, not their reads, for the instant the
-- constraint is added; nothing to validate). Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 / 0185 / 0186 / 0187 pattern) - a regenerate drops
-- them silently. Every table is registered as an `rls` entry in `schema-contract.ts` and listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (only while no invoice or credit note exists; an issued one is a tax record and is kept):
--   DROP TABLE IF EXISTS "credit_notes";
--   DROP TABLE IF EXISTS "invoices";
--   DROP TABLE IF EXISTS "invoice_number_series";
--   DROP TABLE IF EXISTS "payer_billing_details";
--   DROP TABLE IF EXISTS "seller_tax_config";
-- ==============================================================================
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_refund_id" uuid NOT NULL,
	"credit_note_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"taxable_paise" integer NOT NULL,
	"cgst_paise" integer NOT NULL,
	"sgst_paise" integer NOT NULL,
	"igst_paise" integer NOT NULL,
	"total_paise" integer NOT NULL,
	"pdf_storage_key" text,
	"pdf_rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_paise_chk" CHECK ("credit_notes"."taxable_paise" >= 0 AND "credit_notes"."cgst_paise" >= 0 AND "credit_notes"."sgst_paise" >= 0 AND "credit_notes"."igst_paise" >= 0 AND "credit_notes"."total_paise" >= 0),
	CONSTRAINT "credit_notes_sum_chk" CHECK ("credit_notes"."taxable_paise" + "credit_notes"."cgst_paise" + "credit_notes"."sgst_paise" + "credit_notes"."igst_paise" = "credit_notes"."total_paise"),
	CONSTRAINT "credit_notes_split_chk" CHECK ("credit_notes"."igst_paise" = 0 OR ("credit_notes"."cgst_paise" = 0 AND "credit_notes"."sgst_paise" = 0)),
	CONSTRAINT "credit_notes_number_chk" CHECK (char_length("credit_notes"."credit_note_number") <= 16 AND "credit_notes"."financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "credit_notes_pdf_chk" CHECK (("credit_notes"."pdf_storage_key" IS NULL) = ("credit_notes"."pdf_rendered_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "credit_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoice_number_series" (
	"series" text NOT NULL,
	"financial_year" text NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invoice_number_series_pk" PRIMARY KEY("series","financial_year"),
	CONSTRAINT "invoice_number_series_series_chk" CHECK ("invoice_number_series"."series" IN ('invoice', 'credit_note')),
	CONSTRAINT "invoice_number_series_fy_chk" CHECK ("invoice_number_series"."financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "invoice_number_series_last_chk" CHECK ("invoice_number_series"."last_number" >= 0)
);
--> statement-breakpoint
ALTER TABLE "invoice_number_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_order_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"seller_legal_name" text NOT NULL,
	"seller_gstin" text NOT NULL,
	"seller_pan" text NOT NULL,
	"seller_state_code" text NOT NULL,
	"seller_address" text NOT NULL,
	"sac_code" text NOT NULL,
	"buyer_state_code" text NOT NULL,
	"buyer_gstin_enc" text,
	"buyer_legal_name_enc" text,
	"buyer_address_enc" text,
	"supply_type" text NOT NULL,
	"description" text NOT NULL,
	"taxable_paise" integer NOT NULL,
	"cgst_paise" integer NOT NULL,
	"sgst_paise" integer NOT NULL,
	"igst_paise" integer NOT NULL,
	"total_paise" integer NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"pdf_storage_key" text,
	"pdf_rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_supply_chk" CHECK ("invoices"."supply_type" IN ('intra', 'inter')),
	CONSTRAINT "invoices_paise_chk" CHECK ("invoices"."taxable_paise" >= 0 AND "invoices"."cgst_paise" >= 0 AND "invoices"."sgst_paise" >= 0 AND "invoices"."igst_paise" >= 0 AND "invoices"."total_paise" >= 0),
	CONSTRAINT "invoices_sum_chk" CHECK ("invoices"."taxable_paise" + "invoices"."cgst_paise" + "invoices"."sgst_paise" + "invoices"."igst_paise" = "invoices"."total_paise"),
	CONSTRAINT "invoices_split_chk" CHECK (("invoices"."supply_type" = 'intra' AND "invoices"."igst_paise" = 0) OR ("invoices"."supply_type" = 'inter' AND "invoices"."cgst_paise" = 0 AND "invoices"."sgst_paise" = 0)),
	CONSTRAINT "invoices_place_chk" CHECK (("invoices"."supply_type" = 'intra') = ("invoices"."buyer_state_code" = "invoices"."seller_state_code") AND "invoices"."buyer_state_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "invoices_rate_chk" CHECK ("invoices"."gst_rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "invoices_number_chk" CHECK (char_length("invoices"."invoice_number") <= 16 AND "invoices"."financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "invoices_buyer_chk" CHECK ("invoices"."buyer_gstin_enc" IS NULL OR ("invoices"."buyer_legal_name_enc" IS NOT NULL AND "invoices"."buyer_address_enc" IS NOT NULL)),
	CONSTRAINT "invoices_pdf_chk" CHECK (("invoices"."pdf_storage_key" IS NULL) = ("invoices"."pdf_rendered_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payer_billing_details" (
	"payer_id" uuid PRIMARY KEY NOT NULL,
	"state_code" text NOT NULL,
	"gstin_enc" text,
	"legal_name_enc" text,
	"address_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "payer_billing_details_state_chk" CHECK ("payer_billing_details"."state_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "payer_billing_details_gstin_chk" CHECK ("payer_billing_details"."gstin_enc" IS NULL OR ("payer_billing_details"."legal_name_enc" IS NOT NULL AND "payer_billing_details"."address_enc" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "payer_billing_details" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "seller_tax_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"gstin" text NOT NULL,
	"pan" text NOT NULL,
	"state_code" text NOT NULL,
	"address" text NOT NULL,
	"sac_code" text NOT NULL,
	"invoice_prefix" text NOT NULL,
	"credit_note_prefix" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_tax_config_state_chk" CHECK ("seller_tax_config"."state_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "seller_tax_config_gstin_chk" CHECK ("seller_tax_config"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' AND substr("seller_tax_config"."gstin", 1, 2) = "seller_tax_config"."state_code" AND substr("seller_tax_config"."gstin", 3, 10) = "seller_tax_config"."pan"),
	CONSTRAINT "seller_tax_config_pan_chk" CHECK ("seller_tax_config"."pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
	CONSTRAINT "seller_tax_config_sac_chk" CHECK ("seller_tax_config"."sac_code" ~ '^[0-9]{6}$'),
	CONSTRAINT "seller_tax_config_prefix_chk" CHECK ("seller_tax_config"."invoice_prefix" ~ '^[A-Z][A-Z0-9]{0,2}$' AND "seller_tax_config"."credit_note_prefix" ~ '^[A-Z][A-Z0-9]{0,2}$' AND "seller_tax_config"."invoice_prefix" <> "seller_tax_config"."credit_note_prefix"),
	CONSTRAINT "seller_tax_config_text_chk" CHECK (length(btrim("seller_tax_config"."legal_name")) > 0 AND length(btrim("seller_tax_config"."address")) > 0)
);
--> statement-breakpoint
ALTER TABLE "seller_tax_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_payment_refund_id_payment_refunds_id_fk" FOREIGN KEY ("payment_refund_id") REFERENCES "public"."payment_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_order_id_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_refund_uq" ON "credit_notes" USING btree ("payment_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_number_uq" ON "credit_notes" USING btree ("credit_note_number");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_uq" ON "invoices" USING btree ("payment_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_payer_idx" ON "invoices" USING btree ("payer_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "seller_tax_config_one_active_uq" ON "seller_tax_config" USING btree ("is_active") WHERE "seller_tax_config"."is_active";

--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on all five tables.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 / 0185 / 0186 / 0187 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "seller_tax_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "seller_tax_config" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "seller_tax_config" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "seller_tax_config" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "seller_tax_config" FROM service_role;--> statement-breakpoint
ALTER TABLE "payer_billing_details" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_billing_details" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_billing_details" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_billing_details" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_billing_details" FROM service_role;--> statement-breakpoint
ALTER TABLE "invoice_number_series" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "invoice_number_series" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "invoice_number_series" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "invoice_number_series" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "invoice_number_series" FROM service_role;--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "invoices" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "invoices" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "invoices" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "invoices" FROM service_role;--> statement-breakpoint
ALTER TABLE "credit_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_notes" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_notes" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_notes" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_notes" FROM service_role;

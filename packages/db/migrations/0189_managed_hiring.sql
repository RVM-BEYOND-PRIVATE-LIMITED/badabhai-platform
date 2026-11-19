-- ==============================================================================
-- Managed Hiring: orders, the phone-confirmed tracker, callback requests (#2751 items 4 to 13)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2751 items 4 to 13 (brief section 2 and 4B.9; register B2-31 to B2-33, B4B-32 to B4B-36,
-- B7-05, B7-15). A company pays, per job, for BadaBhai's desk to find workers who confirm by phone
-- that they are interested: 5 in 7 working days, free extension to day 30. Never a hire promise.
--
--  - `managed_hiring_orders`: one prepaid order per job (at most one OPEN order per job, a
--    partial unique index), its tier, list price and clock terms stamped at checkout, its clock
--    (`started_at`, `due_at`, `extended_until`) stamped on payment capture.
--  - `managed_hiring_interest`: the tracker. One row per order and worker, added by staff with a
--    short note. The worker FK cascades (erasure takes his rows and the note).
--  - `managed_hiring_callback_requests`: a job above the largest tier (11+ vacancies) asks for a
--    call instead of a checkout; one per job.
--  - `payment_orders_product_kind_chk` is WIDENED from ('credit_pack') to ('credit_pack',
--    'managed_hiring'): a Managed Hiring checkout is a `payment_orders` row of its own kind (no pack
--    code, no credits; `payment_orders_pack_code_chk` and `payment_orders_credits_pos_chk` already
--    bind a `credit_pack` order only).
--
-- PII: ids, closed codes, integers and times, plus `managed_hiring_interest.note` (a staff note,
-- at most 500 characters, never on an event, never shown to the company).
--
-- ADDITIVE ONLY. Three new, EMPTY tables, their indexes and foreign keys, and one CHECK widened
-- (every existing `payment_orders` row is `credit_pack`, which both the old and the new CHECK
-- admit). No existing column, index or row moves. Nothing is seeded.
--
-- DEPLOY ORDER - APPLY BEFORE MANAGED_HIRING_ROLLOUT IS SET TO pilot OR on, NOT BEFORE THE DEPLOY.
-- Nothing names these tables, and nothing writes a `managed_hiring` payment order, while the switch
-- is off for every company (the default): the Managed Hiring routes answer 404, the contact-cost
-- read skips the tracker, and the sweep does not run. The old code never writes `managed_hiring`,
-- so the widened CHECK changes nothing for it.
-- Apply every lower-numbered migration first (slot order), then this.
--
-- LOCKS. The three tables are new and empty. The foreign keys take a brief SHARE ROW EXCLUSIVE lock
-- on `job_postings`, `payment_orders` and `workers` (blocks their writes, not their reads, for the
-- instant each constraint is added; nothing to validate). The CHECK swap takes an ACCESS EXCLUSIVE
-- lock on `payment_orders` and re-validates its rows (a small table: one row per checkout). Apply
-- by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` so the CHECK is never dropped
-- without its replacement, and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 / 0185 / 0186 / 0187 pattern) - a
-- regenerate drops them silently. The tables are registered as `rls` entries in
-- `schema-contract.ts` and listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch MANAGED_HIRING_ROLLOUT off first; orders, trackers and callback requests are
-- lost; refused while a `managed_hiring` payment order exists, which must then stay):
--   DROP TABLE IF EXISTS "managed_hiring_interest";
--   DROP TABLE IF EXISTS "managed_hiring_callback_requests";
--   DROP TABLE IF EXISTS "managed_hiring_orders";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_product_kind_chk";
--   ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_product_kind_chk"
--     CHECK ("payment_orders"."product_kind" IN ('credit_pack'));
-- ==============================================================================
CREATE TABLE "managed_hiring_callback_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"vacancy_band" text NOT NULL,
	"reason" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_hiring_callback_requests_reason_chk" CHECK ("managed_hiring_callback_requests"."reason" IN ('above_largest_tier')),
	CONSTRAINT "managed_hiring_callback_requests_band_chk" CHECK ("managed_hiring_callback_requests"."vacancy_band" IN ('1', '2-5', '6-10', '11-25', '25+'))
);
--> statement-breakpoint
ALTER TABLE "managed_hiring_callback_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "managed_hiring_interest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "managed_hiring_interest_note_len_chk" CHECK (char_length("managed_hiring_interest"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "managed_hiring_interest" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "managed_hiring_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"payment_order_id" uuid NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"price_inr" integer NOT NULL,
	"target_count" integer NOT NULL,
	"working_days" integer NOT NULL,
	"extension_days" integer NOT NULL,
	"started_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"extended_until" timestamp with time zone,
	"extended_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_hiring_orders_status_chk" CHECK ("managed_hiring_orders"."status" IN ('created', 'active', 'met', 'extended', 'closed_unmet', 'cancelled')),
	CONSTRAINT "managed_hiring_orders_tier_chk" CHECK ("managed_hiring_orders"."tier" IN ('standard', 'large')),
	CONSTRAINT "managed_hiring_orders_terms_pos_chk" CHECK ("managed_hiring_orders"."price_inr" > 0 AND "managed_hiring_orders"."target_count" > 0 AND "managed_hiring_orders"."working_days" > 0 AND "managed_hiring_orders"."extension_days" >= "managed_hiring_orders"."working_days"),
	CONSTRAINT "managed_hiring_orders_clock_chk" CHECK ("managed_hiring_orders"."status" IN ('created', 'cancelled') OR ("managed_hiring_orders"."started_at" IS NOT NULL AND "managed_hiring_orders"."due_at" IS NOT NULL AND "managed_hiring_orders"."extended_until" IS NOT NULL)),
	CONSTRAINT "managed_hiring_orders_clock_order_chk" CHECK ("managed_hiring_orders"."due_at" IS NULL OR ("managed_hiring_orders"."due_at" > "managed_hiring_orders"."started_at" AND "managed_hiring_orders"."extended_until" >= "managed_hiring_orders"."due_at"))
);
--> statement-breakpoint
ALTER TABLE "managed_hiring_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_product_kind_chk";--> statement-breakpoint
ALTER TABLE "managed_hiring_callback_requests" ADD CONSTRAINT "managed_hiring_callback_requests_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_hiring_interest" ADD CONSTRAINT "managed_hiring_interest_order_id_managed_hiring_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."managed_hiring_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_hiring_interest" ADD CONSTRAINT "managed_hiring_interest_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_hiring_orders" ADD CONSTRAINT "managed_hiring_orders_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_hiring_orders" ADD CONSTRAINT "managed_hiring_orders_payment_order_id_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_hiring_callback_requests_job_uq" ON "managed_hiring_callback_requests" USING btree ("job_posting_id");--> statement-breakpoint
CREATE INDEX "managed_hiring_callback_requests_created_idx" ON "managed_hiring_callback_requests" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "managed_hiring_interest_order_worker_uq" ON "managed_hiring_interest" USING btree ("order_id","worker_id");--> statement-breakpoint
CREATE INDEX "managed_hiring_interest_payer_worker_idx" ON "managed_hiring_interest" USING btree ("payer_id","worker_id");--> statement-breakpoint
CREATE INDEX "managed_hiring_interest_worker_idx" ON "managed_hiring_interest" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_hiring_orders_payment_order_uq" ON "managed_hiring_orders" USING btree ("payment_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_hiring_orders_open_job_uq" ON "managed_hiring_orders" USING btree ("job_posting_id") WHERE "managed_hiring_orders"."status" IN ('created', 'active', 'extended');--> statement-breakpoint
CREATE INDEX "managed_hiring_orders_status_due_idx" ON "managed_hiring_orders" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "managed_hiring_orders_payer_created_idx" ON "managed_hiring_orders" USING btree ("payer_id","created_at");--> statement-breakpoint
CREATE INDEX "managed_hiring_orders_created_idx" ON "managed_hiring_orders" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_product_kind_chk" CHECK ("payment_orders"."product_kind" IN ('credit_pack', 'managed_hiring'));

--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 / 0185 / 0186 / 0187 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "managed_hiring_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_orders" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_orders" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_orders" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_orders" FROM service_role;--> statement-breakpoint
ALTER TABLE "managed_hiring_interest" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_interest" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_interest" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_interest" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_interest" FROM service_role;--> statement-breakpoint
ALTER TABLE "managed_hiring_callback_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_callback_requests" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_callback_requests" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_callback_requests" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "managed_hiring_callback_requests" FROM service_role;

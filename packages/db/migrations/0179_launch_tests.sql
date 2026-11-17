-- ==============================================================================
-- launch_tests: the records of launch test A (#2755 item 9)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2755 item 9, brief 11.1. The question: will factories pay for non-RVM workers on a new app?
-- About 30 factories outside the RVM portal each get five real matching worker profiles and a
-- Rs 1,179 payment link. THE DESK RECORDS EACH FACTORY BY HAND (`POST` and
-- `PATCH /admin/launch-tests/cohort`). Nothing here sends a profile, creates a payment link or
-- charges money.
--
-- TWO NEW TABLES.
--   `launch_test_cohort` - one row per factory: its name and phone as AES ciphertext, the phone's
--     keyed HMAC (`hashPhone`, the same as `payers.phone_hash`), part A's city and trade groups,
--     its BadaBhai account when it has one (`payer_id`), who sent the profiles and when, the
--     payment link's ref and creation time, the result (`pending` / `paid` / `declined` /
--     `no_response`), when it paid, the real paid order it paid with, and who last changed it.
--   `launch_test_shares` - one row per worker sent to a factory: (cohort_id, worker_id) is the
--     PRIMARY KEY, with the time it was shared. At most five per factory: the service counts them
--     under a lock on the factory row, inside the write transaction.
--
-- CHECKS. `launch_test_cohort_result_chk` (the closed result set, `LAUNCH_TEST_RESULTS`);
-- `launch_test_cohort_paid_chk` (`paid_at` is set exactly when the result is `paid`);
-- `launch_test_cohort_link_ref_chk` (the link ref is 1 to 300 characters); `launch_test_cohort_
-- link_chk` (a link's creation time needs the ref beside it); `launch_test_cohort_phone_chk` (the
-- phone's ciphertext and its hash together, or neither).
--
-- KEYS AND INDEXES. `launch_test_cohort_phone_hash_uq` (one row per factory phone; a factory
-- recorded without a phone is not held to it), `launch_test_cohort_payment_order_uq` (one factory
-- per paid order; backs that FK's SET NULL), `launch_test_cohort_payer_id_idx` (backs the payer
-- FK's SET NULL) and `launch_test_shares_worker_id_idx` (backs the worker FK's CASCADE: DPDP
-- erasure removes a worker's shares).
--
-- PII. The factory's name and phone are ciphertext under the API's PII key; the name is read back
-- only through `AdminIdentityService` (read_identity, the egress cap, `admin.identity_viewed`
-- committed before the decrypt), and the phone never is. Worker ids are opaque.
--
-- ADDITIVE ONLY. Two new, empty tables; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names either table while
-- ADMIN_NUMBERS_ENABLED (default false) is off: every `/admin/launch-tests/*` route is a 404 before
-- any query. With the switch on before this migration, the three cohort routes answer 503 (42P01,
-- fail closed: nothing is written) while the other numbers routes keep working.
-- Apply every lower-numbered migration first (slot order), then this, then arm
-- ADMIN_NUMBERS_ENABLED.
--
-- LOCKS. CREATE TABLE is instant, but the three FOREIGN KEYS take SHARE ROW EXCLUSIVE on `payers`,
-- `payment_orders` and `workers`, which blocks writes to them while each waits behind a long
-- transaction. Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry
-- on 55P03 (the 0170 / 0171 / 0172 / 0173 / 0175 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0167 / 0170 / 0171 / 0172 / 0173 / 0175 pattern) - a regenerate drops them
-- silently. Registered as two `rls` entries in `schema-contract.ts`; both tables are listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch ADMIN_NUMBERS_ENABLED off and redeploy first; the test A records are lost):
--   DROP TABLE "launch_test_shares";
--   DROP TABLE "launch_test_cohort";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "launch_test_cohort" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"factory_name_enc" text NOT NULL,
	"factory_phone_enc" text,
	"factory_phone_hash" text,
	"city_group" text NOT NULL,
	"trade_group" text NOT NULL,
	"payer_id" uuid,
	"sent_by_admin_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"payment_link_ref" text,
	"link_created_at" timestamp with time zone,
	"result" text DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"payment_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" uuid NOT NULL,
	CONSTRAINT "launch_test_cohort_result_chk" CHECK ("launch_test_cohort"."result" IN ('pending', 'paid', 'declined', 'no_response')),
	CONSTRAINT "launch_test_cohort_paid_chk" CHECK (("launch_test_cohort"."paid_at" IS NOT NULL) = ("launch_test_cohort"."result" = 'paid')),
	CONSTRAINT "launch_test_cohort_link_ref_chk" CHECK ("launch_test_cohort"."payment_link_ref" IS NULL OR char_length("launch_test_cohort"."payment_link_ref") BETWEEN 1 AND 300),
	CONSTRAINT "launch_test_cohort_link_chk" CHECK ("launch_test_cohort"."link_created_at" IS NULL OR "launch_test_cohort"."payment_link_ref" IS NOT NULL),
	CONSTRAINT "launch_test_cohort_phone_chk" CHECK (("launch_test_cohort"."factory_phone_enc" IS NULL) = ("launch_test_cohort"."factory_phone_hash" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "launch_test_cohort" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "launch_test_shares" (
	"cohort_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "launch_test_shares_pk" PRIMARY KEY("cohort_id","worker_id")
);
--> statement-breakpoint
ALTER TABLE "launch_test_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "launch_test_cohort" ADD CONSTRAINT "launch_test_cohort_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_test_cohort" ADD CONSTRAINT "launch_test_cohort_payment_order_id_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_test_shares" ADD CONSTRAINT "launch_test_shares_cohort_id_launch_test_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."launch_test_cohort"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_test_shares" ADD CONSTRAINT "launch_test_shares_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "launch_test_cohort_phone_hash_uq" ON "launch_test_cohort" USING btree ("factory_phone_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_test_cohort_payment_order_uq" ON "launch_test_cohort" USING btree ("payment_order_id");--> statement-breakpoint
CREATE INDEX "launch_test_cohort_payer_id_idx" ON "launch_test_cohort" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX "launch_test_shares_worker_id_idx" ON "launch_test_shares" USING btree ("worker_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on both tables.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the four REVOKEs per table are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "launch_test_cohort" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_cohort" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_cohort" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_cohort" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_cohort" FROM service_role;--> statement-breakpoint
ALTER TABLE "launch_test_shares" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_shares" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_shares" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_shares" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "launch_test_shares" FROM service_role;

-- ==============================================================================
-- 0175 - payment_orders: the money in paise, the product kind, the validity, the origin, `held`
-- ==============================================================================
--
-- #2749 item 9 (checkout) and the storage half of item 7 (GST). An order now charges the pack's
-- GST-inclusive TOTAL, so each order stamps the whole price line `gstPriceLine(price)` computed it
-- from, in integer paise, beside the existing whole-rupee `amount_inr` (which keeps the whole-rupee
-- TOTAL, the issue's money-unit default). Also stamped at order time: how long the pack's credits
-- last (so the settle never re-reads the catalogue, hazard 8), where the purchase started (the
-- origin and, when the buyer's own, the job posting), and what kind of product the order sells
-- (#2751 widens it). A new status, `held`: a capture whose amount is not the order's total grants
-- nothing and parks the order there (hardening 5).
--
-- ALL ADDITIVE. Every new column is nullable or defaulted, so every pre-0175 row and every insert
-- from the OLD build keep working: an old row reads product_kind 'credit_pack', no money columns,
-- no validity, no origin; an old insert names none of the new columns and gets the same. Relaxed,
-- not removed: `pack_code` NOT NULL becomes a CHECK that only a `credit_pack` order needs one, and
-- `payment_orders_credits_pos_chk` binds a `credit_pack` order only. Widened: the status CHECK
-- gains 'held'. Nothing is dropped and no row is rewritten.
--
--   product_kind            text NOT NULL DEFAULT 'credit_pack'  CHECK IN ('credit_pack')
--   taxable_paise, gst_paise, round_off_paise, total_paise, gst_rate_bps   integer, nullable:
--                           all five or none (money_set_chk); total = taxable + gst + round_off,
--                           a positive whole rupee equal to amount_inr x 100 (money_sum_chk)
--   credit_validity_days    integer, nullable, > 0
--   origin                  text, nullable, CHECK IN (PAYMENT_ORDER_ORIGINS)
--   origin_job_posting_id   uuid, nullable, FK job_postings ON DELETE SET NULL (+ partial index)
--
-- DEPLOY ORDER - APPLY BEFORE DEPLOY, AND FROM THE PR BRANCH BEFORE MERGING IT. Merging to main
-- auto-deploys the API. `UnlocksRepository` reads and writes payment_orders with bare `.select()`
-- and `.returning()` (findPaymentOrder, createPaymentOrder, the settle claim, markPaymentOrderFailed,
-- the new hold), and Drizzle 0.45 names every model column there, so against a database without
-- this file every order creation, Razorpay webhook (5xx, so Razorpay redelivers) and browser
-- verify fails with 42703. The new build also writes 'held' and a null pack_code is legal only
-- after this file. Order: apply by hand from the PR branch, probe each object
-- (`db:audit:schema-contract`), adopt the ledger row, THEN merge. Production has
-- PAYMENTS_ENABLE_REAL off, so these routes are dark there; the mock `POST /payer/credits` does
-- not touch payment_orders and is unaffected either way.
--
-- ADOPTION ORDER - DO NOT LIFT THE WATERMARK OVER A PENDING LOWER MIGRATION. drizzle's migrator
-- replays only files whose journal `when` is above the newest recorded row. If any LOWER
-- migration is still unapplied (any of 0164-0174, or whatever sits below this slot on main when it
-- merges), recording this one first lifts the watermark above it and `db:migrate` then skips it
-- SILENTLY, for good. Preferred: apply the pending lower migrations first, in journal order, and
-- record them, then this one. Otherwise: adopt ONLY this migration, pinned
-- (`adopt-migrations.ts --only <this tag>`), and apply + adopt every lower pending one by hand
-- with its own `--only` afterwards (the 0135 precedent) - never an unpinned adoption run.
--
-- THE WINDOW BETWEEN APPLY AND DEPLOY IS SAFE. The OLD build names none of the new columns: its
-- order insert gets product_kind 'credit_pack' and null money, its reads list only the columns its
-- own model knew, and it never writes 'held' or a null pack_code. Its orders (amount_inr = the
-- list price, no total_paise) satisfy every new CHECK, and the new build settles them against
-- `amount_inr` x 100, exactly what the old build asked Razorpay for.
--
-- LOCKS, AND THE HAND-WRITTEN STATEMENT ORDER. Every lock below is held until COMMIT:
--   1. the ten ADD COLUMNs and the DROP NOT NULL - ACCESS EXCLUSIVE on `payment_orders` (every
--      order read and write waits) - catalog-only (nullable, or a constant default), no rewrite.
--   2. DROP + re-ADD `payment_orders_credits_pos_chk` (relaxed) and `payment_orders_status_chk`
--      (widened), then the six new CHECKs - each re-ADD VALIDATES EXISTING ROWS with one scan of
--      the table under the lock above; cheap, `payment_orders` is small (the only writer is the
--      real-order route, dark in production while PAYMENTS_ENABLE_REAL is off).
--   3. CREATE INDEX payment_orders_origin_job_posting_idx - partial, over an all-NULL column, so
--      empty; built non-concurrently under the lock above.
--   4. the FK payment_orders -> job_postings LAST - SHARE ROW EXCLUSIVE on `job_postings` (posting
--      inserts, edits and closes wait; reads, the feed included, do not) - validates an all-NULL
--      column, and is held only until the COMMIT that follows it.
-- No application transaction locks `job_postings` and then `payment_orders` (the settle takes
-- payment_orders, then the wallet; order creation reads job_postings without a lock), so step 4
-- cannot deadlock with a request in flight. drizzle-kit generates the DROPs first and the FK in
-- the middle: after ANY regenerate or renumber, re-apply this order by hand (the migration test
-- pins it). Apply in ONE transaction:
--   BEGIN; SET LOCAL lock_timeout = '3s'; <this file>; COMMIT;
-- and retry on 55P03 (lock_timeout) - the 0129 / 0130 / 0166 / 0167 / 0174 precedent.
--
-- RLS: unchanged. payment_orders is already ENABLE + FORCE + REVOKE (0058); no new table here.
--
-- ROLLBACK. An APP-ONLY rollback is safe on this schema (the old build names no new column) EXCEPT
-- for `held` orders: the old build's settle claim is `status <> 'paid'`, so it would GRANT a held
-- order on a webhook replay or a verify, and its failure handler would overwrite `held` with
-- `failed`. Resolve every held order first (`SELECT id FROM payment_orders WHERE status = 'held'`
-- must return nothing). Reverting the SCHEMA as well (revert the app FIRST: the new build's bare
-- reads name every new column) drops production columns, so only as an incident fix; it loses
-- the paise record, the validity and the origin of every order since this file, and it fails
-- while any row is 'held', has a null pack_code, or grants no credits:
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_origin_job_posting_id_job_postings_id_fk";
--   DROP INDEX "payment_orders_origin_job_posting_idx";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_origin_chk";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_validity_pos_chk";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_money_sum_chk";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_money_set_chk";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_pack_code_chk";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_product_kind_chk";
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_status_chk";
--   ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_status_chk" CHECK ("payment_orders"."status" IN ('created', 'paid', 'failed'));
--   ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_credits_pos_chk";
--   ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_credits_pos_chk" CHECK ("payment_orders"."credits_granted" > 0);
--   ALTER TABLE "payment_orders" ALTER COLUMN "pack_code" SET NOT NULL;
--   ALTER TABLE "payment_orders" DROP COLUMN "origin_job_posting_id", DROP COLUMN "origin",
--     DROP COLUMN "credit_validity_days", DROP COLUMN "gst_rate_bps", DROP COLUMN "total_paise",
--     DROP COLUMN "round_off_paise", DROP COLUMN "gst_paise", DROP COLUMN "taxable_paise",
--     DROP COLUMN "product_kind";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794891953223;
-- (the row whose created_at is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain ADD COLUMN / ADD CONSTRAINT). Apply once.
-- ==============================================================================
-- STEP 1 - the columns (ACCESS EXCLUSIVE on payment_orders from here to COMMIT; catalog-only).
ALTER TABLE "payment_orders" ADD COLUMN "product_kind" text DEFAULT 'credit_pack' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "taxable_paise" integer;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "gst_paise" integer;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "round_off_paise" integer;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "total_paise" integer;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "gst_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "credit_validity_days" integer;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "origin_job_posting_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_orders" ALTER COLUMN "pack_code" DROP NOT NULL;--> statement-breakpoint
-- STEP 2 - the CHECKs. Each ADD validates the existing rows (one scan of a small table).
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_credits_pos_chk";--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_credits_pos_chk" CHECK ("payment_orders"."credits_granted" > 0 OR "payment_orders"."product_kind" <> 'credit_pack');--> statement-breakpoint
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_status_chk";--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_status_chk" CHECK ("payment_orders"."status" IN ('created', 'paid', 'failed', 'held'));--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_product_kind_chk" CHECK ("payment_orders"."product_kind" IN ('credit_pack'));--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_pack_code_chk" CHECK ("payment_orders"."product_kind" <> 'credit_pack' OR "payment_orders"."pack_code" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_money_set_chk" CHECK (("payment_orders"."taxable_paise" IS NULL AND "payment_orders"."gst_paise" IS NULL AND "payment_orders"."round_off_paise" IS NULL AND "payment_orders"."total_paise" IS NULL AND "payment_orders"."gst_rate_bps" IS NULL) OR ("payment_orders"."taxable_paise" IS NOT NULL AND "payment_orders"."gst_paise" IS NOT NULL AND "payment_orders"."round_off_paise" IS NOT NULL AND "payment_orders"."total_paise" IS NOT NULL AND "payment_orders"."gst_rate_bps" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_money_sum_chk" CHECK ("payment_orders"."total_paise" IS NULL OR ("payment_orders"."total_paise" = "payment_orders"."taxable_paise" + "payment_orders"."gst_paise" + "payment_orders"."round_off_paise" AND "payment_orders"."total_paise" > 0 AND "payment_orders"."total_paise" % 100 = 0 AND "payment_orders"."total_paise" = "payment_orders"."amount_inr" * 100 AND "payment_orders"."taxable_paise" >= 0 AND "payment_orders"."gst_paise" >= 0 AND "payment_orders"."gst_rate_bps" BETWEEN 0 AND 10000));--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_validity_pos_chk" CHECK ("payment_orders"."credit_validity_days" IS NULL OR "payment_orders"."credit_validity_days" > 0);--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_origin_chk" CHECK ("payment_orders"."origin" IS NULL OR "payment_orders"."origin" IN ('credits_page', 'unlock_prompt', 'candidate_search', 'posting_flow', 'dashboard', 'other'));--> statement-breakpoint
-- STEP 3 - the FK's referencing-side index (empty: the column is all NULL).
CREATE INDEX "payment_orders_origin_job_posting_idx" ON "payment_orders" USING btree ("origin_job_posting_id") WHERE "payment_orders"."origin_job_posting_id" IS NOT NULL;--> statement-breakpoint
-- STEP 4 - HAND-ORDERED LAST: the job_postings FK (SHARE ROW EXCLUSIVE on job_postings until COMMIT).
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_origin_job_posting_id_job_postings_id_fk" FOREIGN KEY ("origin_job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;

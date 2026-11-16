-- ==============================================================================
-- 0168 - credit_lots + credit_ledger.lot_id: a company's balance, as expiring lots
-- ==============================================================================
--
-- #2749 items 2-4 (brief 4C.1, section 7). A wallet's balance becomes a set of lots: one per
-- grant (a pack bought, an ops grant, the free-tier grant), each with what it granted, what is
-- left and an optional `expires_at`. Credits are spent from the lot that expires soonest (a lot
-- that never expires last), and a lot past its date is closed with ONE `expired` ledger line.
-- `credit_ledger.lot_id` names the lot each movement added to, spent from or expired.
--
-- THE INVARIANT, per wallet (`payer_id` = the tenant key, ADR-0053):
--   payer_credits.balance = sum(credit_lots.credits_remaining) = sum(credit_ledger.delta).
-- Every writer goes through packages/db/src/credit-wallet.ts under the wallet row lock, in ONE
-- order (wallet row, then lots, then ledger).
--
-- BACKFILL (in this file, last): one `legacy` lot per `payer_credits` row with balance > 0
-- (granted = remaining = balance, no expiry, is_test false). NO ledger line: the ledger already
-- holds the grants that balance came from, so sum(delta) is unchanged. Guarded by NOT EXISTS, so
-- the INSERT alone can be re-run. Nothing in this PR writes an `expires_at`: a legacy lot never
-- expires until the switch-over decides otherwise (#2749 "Defaults behind the questions").
--
-- DEPLOY ORDER - APPLY BEFORE DEPLOY, AND FROM THE PR BRANCH BEFORE MERGING IT. Merging to main
-- auto-deploys the API, and Drizzle 0.45 names EVERY model column in each insert, so the new
-- build's ledger insert names `lot_id` and its wallet code names `credit_lots`. Against a
-- database without this file every pack purchase, Razorpay settle, contact open, admin grant
-- and free-tier signup grant fails (42703 / 42P01), and `GET /payer/credits` 500s. Order:
-- apply by hand from the PR branch, probe each object (`db:audit:schema-contract`), adopt the
-- ledger row, THEN merge.
--
-- THE WINDOW BETWEEN APPLY AND DEPLOY IS SAFE, AND SELF-HEALING. The OLD build names neither
-- `lot_id` nor `credit_lots` (its inserts list only the columns its own model knew), so it keeps
-- working; but it moves balances without touching lots. The new build's first touch of each
-- wallet re-aligns the lots with the balance under the wallet lock (`alignLotsWithBalance`: top
-- up a never-expiring `legacy` lot, or remove the excess soonest-expiring first) and logs one
-- warning with ids and numbers. Balance stays the source of truth; no company gains or loses a
-- spendable credit. The same heal covers a balance written between the backfill's read and the
-- commit.
--
-- LOCKS. CREATE TABLE is instant. `ADD COLUMN lot_id` (nullable, no default) is catalog-only but
-- takes ACCESS EXCLUSIVE on `credit_ledger` for that instant; the two FOREIGN KEYs take SHARE ROW
-- EXCLUSIVE on `payment_orders`, `credit_ledger` and `credit_lots` (validation is a scan of an
-- all-NULL column), and `credit_ledger_lot_id_idx` is built non-concurrently (a small table).
-- Each queues behind any in-flight purchase or unlock. Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03 (the 0129 / 0130 / 0166
-- / 0167 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs are HAND-WRITTEN (the 0117 / 0156 / 0160
-- / 0161 / 0167 pattern) - a regenerate drops them silently. Registered as `0168-credit-lots-rls`
-- in `schema-contract.ts`; listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (revert the app FIRST: the new build cannot write a ledger line without `lot_id`).
-- Lossy once any lot carries an expiry; drops a production column, so only as an incident fix:
--   ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_lot_id_credit_lots_id_fk";
--   DROP INDEX "credit_ledger_lot_id_idx";
--   ALTER TABLE "credit_ledger" DROP COLUMN "lot_id";
--   DROP TABLE "credit_lots";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794807507414;
-- (the row whose created_at is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE / ADD COLUMN). Apply once. The backfill INSERT alone is.
-- ==============================================================================
CREATE TABLE "credit_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"source" text NOT NULL,
	"pack_code" text,
	"payment_order_id" uuid,
	"credits_granted" integer NOT NULL,
	"credits_remaining" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_lots_source_chk" CHECK ("credit_lots"."source" IN ('pack', 'welcome', 'goodwill', 'returned', 'migrated', 'legacy')),
	CONSTRAINT "credit_lots_granted_pos_chk" CHECK ("credit_lots"."credits_granted" > 0),
	CONSTRAINT "credit_lots_remaining_range_chk" CHECK ("credit_lots"."credits_remaining" >= 0 AND "credit_lots"."credits_remaining" <= "credit_lots"."credits_granted"),
	CONSTRAINT "credit_lots_expired_empty_chk" CHECK ("credit_lots"."expired_at" IS NULL OR "credit_lots"."credits_remaining" = 0)
);
--> statement-breakpoint
ALTER TABLE "credit_lots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_payment_order_id_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_lots_open_spend_idx" ON "credit_lots" USING btree ("payer_id","expires_at","created_at","id") WHERE "credit_lots"."credits_remaining" > 0;--> statement-breakpoint
CREATE INDEX "credit_lots_due_idx" ON "credit_lots" USING btree ("expires_at") WHERE "credit_lots"."credits_remaining" > 0 AND "credit_lots"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_payment_order_uq" ON "credit_lots" USING btree ("payment_order_id") WHERE "credit_lots"."payment_order_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_lot_id_idx" ON "credit_ledger" USING btree ("lot_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "credit_lots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_lots" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_lots" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_lots" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_lots" FROM service_role;--> statement-breakpoint
-- ===========================================================================
-- BACKFILL (HAND-WRITTEN) - one `legacy` lot per balance, so balance = open lots from the start.
-- No ledger line (the ledger already holds these credits). Re-runnable on its own.
-- ===========================================================================
INSERT INTO "credit_lots" ("payer_id", "source", "credits_granted", "credits_remaining", "expires_at", "is_test")
SELECT pc."payer_id", 'legacy', pc."balance", pc."balance", NULL, false
FROM "payer_credits" pc
WHERE pc."balance" > 0
  AND NOT EXISTS (SELECT 1 FROM "credit_lots" l WHERE l."payer_id" = pc."payer_id");

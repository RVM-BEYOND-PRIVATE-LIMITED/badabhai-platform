-- Matching V1 — step 7 of 7: Workstream 3 spine (payment_orders + referral_bonus_accruals).
--
-- EXPAND-ONLY: two NEW tables. Nothing existing is touched. Authored in this train so
-- Divyanshu applies ONE ordered sequence rather than two.
--
-- ⚠️ STRUCTURE ONLY — creating `payment_orders` does NOT enable real money. Real
-- payment-provider keys and spend remain a hard human-gated escalation (CLAUDE.md §7,
-- ADR-0010 §EXPLICITLY OUT, ADR-0013). The table lands now so the idempotency key is a
-- DB constraint from day one instead of being bolted on after the first double-charge.
--
-- ── payment_orders ──────────────────────────────────────────────────────────
-- UNIQUE (provider, provider_order_id) IS THE PAYMENT IDEMPOTENCY KEY. A webhook
-- redelivery, a double-tapped Pay button, or an at-least-once retry all collide there
-- and insert NO second order — therefore no second credit grant. It is a DB constraint
-- because the application-level check is exactly the thing that races. `provider` is
-- part of the key so two providers are never assumed to share an id space.
-- `payer_id` is the opaque faceless-rails ref (NO FK), mirroring payer_credits /
-- credit_ledger, which this sits in front of.
--
-- AMENDED IN PLACE (not a follow-on migration) to add `credits_granted`. This file has
-- never been applied anywhere but a throwaway local cluster and is not on `main`, and the
-- runbook presents this train as ONE ordered pass — so amending keeps that promise instead
-- of shipping a 0059 that immediately alters a table nobody has yet created.
--
-- WHY `credits_granted` EXISTS: the row already stamped `amount_inr`, but the credits the
-- order buys were being re-resolved from the live catalog at CAPTURE time. If ops re-priced
-- or re-sized a pack in between, the buyer paid the stamped amount and received the pack's
-- then-current credits — two sources of truth for one transaction, over an unbounded window
-- (a browser tab left open across a pricing change is enough), and an unreconcilable ledger.
-- Stamping BOTH at creation makes a mid-flight catalog change structurally unable to touch
-- an order that already exists. NOT NULL + CHECK (> 0): an order that buys zero credits is a
-- resolver bug, and the DB is the only place that cannot be forgotten.
--
-- ── referral_bonus_accruals ─────────────────────────────────────────────────
-- UNIQUE (invited_worker_id) IS THE FRAUD RULE'S TEETH: one bonus per REFERRED worker,
-- ever. Deliberately NOT (inviter, invited) — that key would let the same referred
-- worker be claimed once by each of N inviters.
--
-- 🔎 TWO CONSEQUENCES OF THE CASCADE, FLAGGED NOT HIDDEN (both are DPDP-correct, both
-- are product-visible; neither is a DB decision to make alone):
--   1. Both worker FKs are ON DELETE CASCADE, so if the INVITED worker exercises DPDP
--      erasure the INVITER'S accrual row is destroyed with them. Erasure wins over the
--      financial record by design (there is no way to keep the row without keeping a
--      pointer to a deleted person). If finance needs a durable aggregate, it must be an
--      inviter-scoped counter that does not reference the invited worker — a product
--      decision, not a schema one.
--   2. "One bonus per referred worker, EVER" is scoped to the worker ID, not the human.
--      A delete + re-register mints a new `workers.id`, so a new bonus can accrue. That
--      is the unavoidable cost of honouring erasure; closing it would require retaining
--      a phone-derived hash of a deleted worker, which invariant #2 and DPDP both refuse.
--
-- PII-FREE (invariant #2): opaque payer/worker UUIDs, integer ₹ amounts, pack codes and
-- OPAQUE provider ids. NO card number, UPI handle, VPA, bank account, billing name or
-- address column — the same line credit_ledger.payment_ref has held since ADR-0010 §D5.
--
-- LOCKS: CREATE TABLE only — no lock on any live table.
--
-- ROLLBACK (fully reversible while both tables are empty, which they are on arrival —
-- no writer exists until the Workstream 3 API lands):
--   DROP TABLE "payment_orders";
--   DROP TABLE "referral_bonus_accruals";
-- After real orders/accruals exist, DO NOT drop: those rows are the payment audit trail.
CREATE TABLE "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"pack_code" text NOT NULL,
	"amount_inr" integer NOT NULL,
	"credits_granted" integer NOT NULL,
	"provider" text DEFAULT 'razorpay' NOT NULL,
	"provider_order_id" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"provider_payment_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_orders_amount_pos_chk" CHECK ("payment_orders"."amount_inr" > 0),
	CONSTRAINT "payment_orders_credits_pos_chk" CHECK ("payment_orders"."credits_granted" > 0),
	CONSTRAINT "payment_orders_status_chk" CHECK ("payment_orders"."status" IN ('created', 'paid', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "payment_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "referral_bonus_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_worker_id" uuid NOT NULL,
	"invited_worker_id" uuid NOT NULL,
	"amount_inr" integer DEFAULT 20 NOT NULL,
	"qualified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_bonus_accruals_amount_pos_chk" CHECK ("referral_bonus_accruals"."amount_inr" > 0),
	CONSTRAINT "referral_bonus_accruals_no_self_chk" CHECK ("referral_bonus_accruals"."inviter_worker_id" <> "referral_bonus_accruals"."invited_worker_id")
);
--> statement-breakpoint
ALTER TABLE "referral_bonus_accruals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_bonus_accruals" ADD CONSTRAINT "referral_bonus_accruals_inviter_worker_id_workers_id_fk" FOREIGN KEY ("inviter_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_bonus_accruals" ADD CONSTRAINT "referral_bonus_accruals_invited_worker_id_workers_id_fk" FOREIGN KEY ("invited_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_provider_order_uq" ON "payment_orders" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE INDEX "payment_orders_payer_created_idx" ON "payment_orders" USING btree ("payer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_bonus_accruals_invited_uq" ON "referral_bonus_accruals" USING btree ("invited_worker_id");--> statement-breakpoint
CREATE INDEX "referral_bonus_accruals_inviter_idx" ON "referral_bonus_accruals" USING btree ("inviter_worker_id");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20): FORCE RLS + REVOKE ALL for every Data-API role.
-- drizzle-kit emits ENABLE only (above). Same posture as the agency money tables in
-- 0048. Both are registered in tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "payment_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_orders" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_orders" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_orders" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payment_orders" FROM service_role;--> statement-breakpoint
ALTER TABLE "referral_bonus_accruals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_bonus_accruals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_bonus_accruals" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_bonus_accruals" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_bonus_accruals" FROM service_role;
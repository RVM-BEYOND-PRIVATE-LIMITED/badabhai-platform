-- ==============================================================================
-- 0155 - company payment history: stamp ₹ on plan/boost/capacity/top-up rows (#2565 B11)
-- ==============================================================================
--
-- Additive only: three nullable `price_inr` columns + one new receipt table.
-- Nothing existing is altered, dropped or rewritten; no data backfill in SQL
-- (the event-spine backfill `db:backfill:payment-prices` fills `price_inr` later).
--   * posting_plans.price_inr - whole-₹ stamped at plan purchase (quote.finalInr).
--     NULL = row written before this column (renders "not recorded", never guessed).
--   * posting_boosts.price_inr - same, stamped at boost purchase.
--   * payer_capacity.price_inr - the LAST capacity purchase price that wrote this row.
--     Per-purchase history lives on the `capacity.purchased` event spine; this is the
--     receipt on the CURRENT allowance only. NULL = pre-column row or manual grant.
--   * plan_quota_topups - ONE ROW PER quota top-up purchase (the B2 receipt). Previously
--     a top-up existed only as `posting_plans.quota_topup_count += N` plus a
--     `posting_plan.quota_topped` event, so per-top-up ₹ history was event-only.
--
-- APPLY-BEFORE-DEPLOY. Manual apply BEFORE the build that reads these columns deploys
-- (code auto-deploys on merge; migrations never do). The writers
-- (`PostingPlansRepository.insertPlan/insertBoost/upsertCapacity` + the top-up insert)
-- name these columns explicitly, and bare `select()` readers name every model column —
-- so the new build against an unmigrated database 500s plan/boost/capacity/top-up
-- purchases and the payment-history read. The OLD build on a migrated database is
-- fine (a superset). Registered as `0155-payment-history-prices` in
-- `schema-contract.ts`.
--
-- LOCKS. Nullable ADD COLUMNs are catalog-only (PG11+ fast default) but still take a
-- brief ACCESS EXCLUSIVE on `posting_plans` / `posting_boosts` / `payer_capacity`,
-- which are read on the paid path — take it with a short timeout and retry on 55P03.
-- CREATE TABLE touches nothing live. The two FKs take SHARE ROW EXCLUSIVE on
-- `posting_plans` / `job_postings` for their (empty-table, instant) validation.
--
-- ROLLBACK: drop the table + the three columns, then delete the journal row —
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   DROP TABLE "plan_quota_topups";
--   ALTER TABLE "payer_capacity" DROP COLUMN IF EXISTS "price_inr";
--   ALTER TABLE "posting_boosts" DROP COLUMN IF EXISTS "price_inr";
--   ALTER TABLE "posting_plans" DROP COLUMN IF EXISTS "price_inr";
--   DELETE FROM drizzle.__drizzle_migrations WHERE ... (this entry's journal `when`);
--   COMMIT;
-- only AFTER rolling the API back to a build that does not name them. Dropping them
-- loses the stamped ₹ on new purchases (history re-renders as "not recorded") and
-- every quota top-up receipt row (the `posting_plan.quota_topped` events survive).
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
CREATE TABLE "plan_quota_topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"job_posting_id" uuid,
	"payer_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"quota_added" integer NOT NULL,
	"price_inr" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_quota_topups_added_pos_chk" CHECK ("plan_quota_topups"."quota_added" > 0)
);
--> statement-breakpoint
ALTER TABLE "plan_quota_topups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_capacity" ADD COLUMN "price_inr" integer;--> statement-breakpoint
ALTER TABLE "posting_boosts" ADD COLUMN "price_inr" integer;--> statement-breakpoint
ALTER TABLE "posting_plans" ADD COLUMN "price_inr" integer;--> statement-breakpoint
ALTER TABLE "plan_quota_topups" ADD CONSTRAINT "plan_quota_topups_plan_id_posting_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."posting_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_quota_topups" ADD CONSTRAINT "plan_quota_topups_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_quota_topups_plan_id_idx" ON "plan_quota_topups" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "plan_quota_topups_payer_id_idx" ON "plan_quota_topups" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX "plan_quota_topups_payer_created_idx" ON "plan_quota_topups" USING btree ("payer_id","created_at");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
--
-- The posture every payer and worker table since 0071 carries: nothing reaches
-- these rows except the API's BYPASSRLS connection. FORCE matters because it
-- applies to the table OWNER too. `drizzle-kit generate` emits only the ENABLE
-- above; FORCE and the four REVOKEs are hand-written, and a regenerate drops
-- them silently.
-- ===========================================================================
ALTER TABLE "plan_quota_topups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "plan_quota_topups" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "plan_quota_topups" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "plan_quota_topups" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "plan_quota_topups" FROM service_role;

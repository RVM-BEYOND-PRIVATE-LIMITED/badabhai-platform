-- ==============================================================================
-- 0168 - pay_on_joining_hires: the pay-on-joining pilot's record, one row per hire
-- ==============================================================================
--
-- #2753 item 11. The pilot (3 anchor factories, 5 partners, NCR, December to January): a factory
-- pays a fee for a worker who joined and stayed 30 days; the partner who brought him is owed a
-- share, paid when the factory pays; BadaBhai keeps the rest. Admins write each row by hand
-- (POST / PATCH /admin/pay-on-joining-hires). THIS IS A RECORD ONLY: nothing here raises an
-- invoice, moves money, pays a partner or decides which factory qualifies.
--
-- IDS ONLY, apart from the admin note. Factory and partner are opaque payer ids, the worker an
-- opaque worker id, the job an opaque posting id; dates are calendar days. `note` is the one
-- free-text column: an admin's own words (max 500 characters), never logged and never on an
-- event. No name, phone or company name is stored.
--
-- MONEY IN INTEGER PAISE. `partner_share_percent` is COPIED from the POJ_PARTNER_SHARE_PERCENT
-- setting at create time, so a later setting change never rewrites a recorded hire.
-- `partner_share_paise` is computed by the server, never accepted from a client:
-- floor(fee_paise * partner_share_percent / 100); BadaBhai keeps the remainder paisa.
-- `pay_on_joining_hires_share_math_chk` pins that arithmetic (bigint * integer / 100 truncates,
-- the floor for a non-negative fee).
--
-- ONE ROW PER HIRE: `pay_on_joining_hires_hire_uq` is UNIQUE NULLS NOT DISTINCT (factory,
-- worker, job posting), PG15+ (CI runs pg16; 0037 / 0067 use the clause in production already).
-- A posting delete SET-NULLs `job_posting_id`; two hires of one worker at one factory against two
-- postings that are both hard-deleted would then collide and refuse the second delete. Postings
-- are not hard-deleted outside seeds.
--
-- KEYS AND INDEXES. factory_payer_id CASCADE (as feature_pilot_payers and the 0162 / 0163
-- tables: a payer row is only hard-deleted by the QA seam); partner_payer_id SET NULL (the hire
-- stays with its factory); job_posting_id SET NULL; worker_id CASCADE (DPDP erasure removes a
-- worker's hires), indexed, as is partner_payer_id. The unique key's leading column serves the
-- factory filter.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table while
-- PAY_ON_JOINING_RECORDS_ENABLED (default false) is off: every route is a 404 before a query.
-- With the switch on before 0168, the list and both writes fail (42P01) and answer 500; nothing
-- is written. Apply the earlier slots first (slot order), then this.
--
-- LOCKS. CREATE TABLE is instant, but the four FOREIGN KEYs take SHARE ROW EXCLUSIVE on
-- `payers`, `job_postings` and `workers`, which blocks writes to each while it waits behind a
-- long transaction. Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and
-- retry on 55P03 (the 0129 / 0130 / 0166 / 0167 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 pattern) - a regenerate drops them silently. Registered as
-- `0168-pay-on-joining-hires-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the e2e
-- RLS spine.
--
-- ROLLBACK (switch off first; the recorded hires are lost, so export them before):
--   DROP TABLE "pay_on_joining_hires";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at is
-- this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "pay_on_joining_hires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"factory_payer_id" uuid NOT NULL,
	"job_posting_id" uuid,
	"worker_id" uuid NOT NULL,
	"partner_payer_id" uuid,
	"joined_on" date NOT NULL,
	"stay_checked_on" date,
	"stayed_30_days" boolean,
	"fee_paise" bigint NOT NULL,
	"partner_share_percent" integer NOT NULL,
	"partner_share_paise" bigint NOT NULL,
	"invoiced_on" date,
	"factory_paid_on" date,
	"partner_paid_on" date,
	"note" text,
	"created_by_admin_id" uuid NOT NULL,
	"updated_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_on_joining_hires_hire_uq" UNIQUE NULLS NOT DISTINCT("factory_payer_id","worker_id","job_posting_id"),
	CONSTRAINT "pay_on_joining_hires_fee_chk" CHECK ("pay_on_joining_hires"."fee_paise" >= 0),
	CONSTRAINT "pay_on_joining_hires_percent_chk" CHECK ("pay_on_joining_hires"."partner_share_percent" >= 0 AND "pay_on_joining_hires"."partner_share_percent" <= 100),
	CONSTRAINT "pay_on_joining_hires_share_chk" CHECK ("pay_on_joining_hires"."partner_share_paise" >= 0),
	CONSTRAINT "pay_on_joining_hires_share_math_chk" CHECK ("pay_on_joining_hires"."partner_share_paise" = ("pay_on_joining_hires"."fee_paise" * "pay_on_joining_hires"."partner_share_percent") / 100),
	CONSTRAINT "pay_on_joining_hires_stay_check_chk" CHECK (("pay_on_joining_hires"."stay_checked_on" IS NULL) = ("pay_on_joining_hires"."stayed_30_days" IS NULL)),
	CONSTRAINT "pay_on_joining_hires_note_chk" CHECK ("pay_on_joining_hires"."note" IS NULL OR char_length("pay_on_joining_hires"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "pay_on_joining_hires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pay_on_joining_hires" ADD CONSTRAINT "pay_on_joining_hires_factory_payer_id_payers_id_fk" FOREIGN KEY ("factory_payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_on_joining_hires" ADD CONSTRAINT "pay_on_joining_hires_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_on_joining_hires" ADD CONSTRAINT "pay_on_joining_hires_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_on_joining_hires" ADD CONSTRAINT "pay_on_joining_hires_partner_payer_id_payers_id_fk" FOREIGN KEY ("partner_payer_id") REFERENCES "public"."payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pay_on_joining_hires_worker_id_idx" ON "pay_on_joining_hires" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "pay_on_joining_hires_partner_payer_id_idx" ON "pay_on_joining_hires" USING btree ("partner_payer_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "pay_on_joining_hires" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "pay_on_joining_hires" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "pay_on_joining_hires" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "pay_on_joining_hires" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "pay_on_joining_hires" FROM service_role;

-- ==============================================================================
-- company_import_notices: the send log of the first sign-in message to a moved company (#2787)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2787 (parent #2754). After a Campus import batch is applied and its verification report is
-- clean, `import-campus-companies.cli.ts --notify --send` tells each company the batch placed how
-- to sign in on BadaBhai, by email and (once an approved DLT template exists) by SMS. This table
-- is the send log: ONE ROW PER COMPANY PER CHANNEL, unique on (payer_id, channel), so a second
-- run sends nothing more on a channel already `sent`, and a `failed` or `skipped` notice is tried
-- again by the next run. `reason` is a short machine code; no address, number or provider message.
-- No PII.
--
-- ADDITIVE ONLY. One new, EMPTY table, its two indexes and two foreign keys (to
-- `company_import_batches`, ON DELETE RESTRICT, and to `payers`, ON DELETE CASCADE so erasing a
-- company erases its log). No existing table, column, constraint or row is touched. Nothing is
-- seeded.
--
-- DEPLOY ORDER - APPLY BEFORE THE FIRST `--notify --send` RUN, NOT BEFORE THE DEPLOY. Only the
-- import CLI names this table; no route, sweep or read path does. A deploy ahead of this file
-- breaks nothing. The CLI refuses `--notify` when the table is missing.
--
-- LOCKS. The foreign key to `payers` takes SHARE ROW EXCLUSIVE on `payers` for a moment (the new
-- table is empty, so there is nothing to validate). Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 / 0183 pattern) - a regenerate drops them
-- silently. The table is registered as an `rls` entry in `schema-contract.ts` and listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (loses the send log; a later `--notify --send` would message every company again):
--   DROP TABLE "company_import_notices";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "company_import_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"run_by" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_import_notices_channel_chk" CHECK ("company_import_notices"."channel" IN ('email', 'sms')),
	CONSTRAINT "company_import_notices_state_chk" CHECK ("company_import_notices"."state" IN ('sent', 'failed', 'skipped')),
	CONSTRAINT "company_import_notices_outcome_chk" CHECK (("company_import_notices"."state" = 'sent') = ("company_import_notices"."sent_at" IS NOT NULL) AND ("company_import_notices"."state" = 'sent') = ("company_import_notices"."reason" IS NULL) AND ("company_import_notices"."reason" IS NULL OR char_length("company_import_notices"."reason") BETWEEN 1 AND 64)),
	CONSTRAINT "company_import_notices_text_chk" CHECK (char_length("company_import_notices"."run_by") BETWEEN 1 AND 128 AND "company_import_notices"."attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "company_import_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_import_notices" ADD CONSTRAINT "company_import_notices_batch_id_company_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."company_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_import_notices" ADD CONSTRAINT "company_import_notices_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_import_notices_payer_channel_uq" ON "company_import_notices" USING btree ("payer_id","channel");--> statement-breakpoint
CREATE INDEX "company_import_notices_batch_idx" ON "company_import_notices" USING btree ("batch_id","state");
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 / 0183 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "company_import_notices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_notices" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_notices" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_notices" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "company_import_notices" FROM service_role;

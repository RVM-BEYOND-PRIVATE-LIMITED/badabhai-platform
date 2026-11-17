-- ==============================================================================
-- credit_call_log: the out-of-credits call log (#2755 part C)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2755 item 8, metric group 10. GET /admin/numbers/out-of-credits lists the countable
-- companies whose usable balance is zero now, newest first by the moment they ran out; the
-- telecaller calls them and logs each call with POST /admin/numbers/out-of-credits/:payerId/calls.
-- One row per call: the company, the admin who logged it, when, and ONE CLOSED RESULT CODE
-- (`reached_will_buy`, `reached_not_now`, `reached_declined`, `no_answer`, `wrong_number`;
-- `credit_call_log_result_chk`, the list is CREDIT_CALL_RESULTS in @badabhai/types). No note,
-- name, phone or free text of any kind. The list shows each company's latest entry.
--
-- APPEND-ONLY BY USE: the route inserts and nothing updates or deletes a row. The row's id is
-- derived from the admin and the request's Idempotency-Key, so a retried POST inserts nothing
-- (and emits nothing a second time).
--
-- KEYS AND INDEXES. `credit_call_log_payer_called_idx` (payer_id, called_at DESC) is the list's
-- latest-call-per-company read and backs the payer_id ON DELETE CASCADE (a company erased takes
-- its calls with it). `called_by_admin_id` has no FK, as on every admin-actor column.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table
-- while ADMIN_NUMBERS_ENABLED (default false) is off: every /admin/numbers route is a 404.
-- With the switch on before this migration, the list still answers (every row with
-- `last_call: null`) and the POST answers 503 (42P01: fail closed, nothing written).
-- Apply every lower-numbered migration first (slot order), then this.
--
-- LOCKS. CREATE TABLE is instant, but the FOREIGN KEY takes SHARE ROW EXCLUSIVE on `payers`,
-- which blocks writes to it (sign-ins stamp last_login_at) while it waits behind a long
-- transaction. Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and
-- retry on 55P03.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN - a
-- regenerate drops them silently. Registered as an `rls` entry in `schema-contract.ts`; listed
-- in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch ADMIN_NUMBERS_ENABLED off and redeploy first; the call history is lost -
-- the spine keeps every `admin.credit_call_logged` with its result code):
--   DROP TABLE "credit_call_log";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "credit_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"called_by_admin_id" uuid NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text NOT NULL,
	CONSTRAINT "credit_call_log_result_chk" CHECK ("credit_call_log"."result" IN ('reached_will_buy', 'reached_not_now', 'reached_declined', 'no_answer', 'wrong_number'))
);
--> statement-breakpoint
ALTER TABLE "credit_call_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_call_log" ADD CONSTRAINT "credit_call_log_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_call_log_payer_called_idx" ON "credit_call_log" USING btree ("payer_id","called_at" DESC NULLS LAST);
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN, because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "credit_call_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_call_log" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_call_log" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_call_log" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_call_log" FROM service_role;

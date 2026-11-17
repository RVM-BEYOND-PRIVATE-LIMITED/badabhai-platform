-- ==============================================================================
-- contact_reach_cases + contact_reach_attempts: the working-number guarantee and the worker desk
-- (#2750 item 7)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2750 item 7 (brief 4C.9, B7-13). A company under the credit rules that opened a contact and
-- could not reach the worker reports it within `couldntReachWindowDays` (7) of the open. That opens
-- ONE case per open (`contact_reach_cases_unlock_uq`), with a deadline `deskWindowHours` (48) away.
-- The worker desk calls him (each call is a `contact_reach_attempts` row: the admin, the time, a
-- closed result code) and closes the case: reached and interested, reached and declined (no credit
-- back), or not reached (the credits the open took come back as `returned` lots and ledger lines).
-- A case still open at its deadline closes as not reached, attempted or not (owner ruling
-- 2026-11-17).
--
-- PII-FREE: ids, closed codes, integers and times. No free text on either table.
--
-- ADDITIVE ONLY. Two new, EMPTY tables, their indexes and four foreign keys; no existing column,
-- constraint or row moves. Nothing is seeded. `credit_ledger.reason` is plain text with no CHECK
-- and `credit_lots.source` already allows `returned` (0174), so the returns need no DDL.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names these tables while
-- CREDIT_RULES_ROLLOUT is off: the payer and desk routes answer 404 and the deadline sweep does
-- nothing. With the switch on before this file, those routes answer 503 and the sweep logs and
-- waits. Apply every lower-numbered migration first (slot order), then this, then set the switch.
--
-- LOCKS. The two new tables are empty. The foreign keys take a brief SHARE ROW EXCLUSIVE lock on
-- `unlocks` and `workers` (blocks their writes, not their reads, for the instant the constraint
-- is added; nothing to validate). Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 pattern) - a regenerate drops them silently.
-- Both tables are registered as `rls` entries in `schema-contract.ts` and listed in LOCKED_TABLES
-- in the e2e RLS spine.
--
-- ROLLBACK (switch CREDIT_RULES_ROLLOUT off and redeploy first; every case and attempt is lost;
-- credits already returned stay returned, as `returned` lots and ledger lines):
--   DROP TABLE "contact_reach_attempts";
--   DROP TABLE "contact_reach_cases";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "contact_reach_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"result" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_reach_attempts_result_chk" CHECK ("contact_reach_attempts"."result" IN ('no_answer', 'busy', 'switched_off', 'wrong_number', 'other'))
);
--> statement-breakpoint
ALTER TABLE "contact_reach_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_reach_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unlock_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"worker_id" uuid,
	"reported_by" uuid NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"credits_returned" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_by_admin_id" uuid,
	CONSTRAINT "contact_reach_cases_status_chk" CHECK ("contact_reach_cases"."status" IN ('open', 'reached_interested', 'reached_declined', 'not_reached')),
	CONSTRAINT "contact_reach_cases_credits_chk" CHECK ("contact_reach_cases"."credits_returned" >= 0),
	CONSTRAINT "contact_reach_cases_resolved_by_chk" CHECK ("contact_reach_cases"."resolved_by" IS NULL OR "contact_reach_cases"."resolved_by" IN ('desk', 'deadline')),
	CONSTRAINT "contact_reach_cases_resolution_chk" CHECK (("contact_reach_cases"."status" = 'open') = ("contact_reach_cases"."resolved_at" IS NULL) AND ("contact_reach_cases"."resolved_at" IS NULL) = ("contact_reach_cases"."resolved_by" IS NULL) AND ("contact_reach_cases"."resolved_by_admin_id" IS NULL OR "contact_reach_cases"."resolved_by" = 'desk'))
);
--> statement-breakpoint
ALTER TABLE "contact_reach_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_reach_attempts" ADD CONSTRAINT "contact_reach_attempts_case_id_contact_reach_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."contact_reach_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reach_cases" ADD CONSTRAINT "contact_reach_cases_unlock_id_unlocks_id_fk" FOREIGN KEY ("unlock_id") REFERENCES "public"."unlocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reach_cases" ADD CONSTRAINT "contact_reach_cases_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_reach_attempts_case_idx" ON "contact_reach_attempts" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_reach_cases_unlock_uq" ON "contact_reach_cases" USING btree ("unlock_id");--> statement-breakpoint
CREATE INDEX "contact_reach_cases_open_deadline_idx" ON "contact_reach_cases" USING btree ("deadline_at") WHERE "contact_reach_cases"."status" = 'open';--> statement-breakpoint
CREATE INDEX "contact_reach_cases_payer_idx" ON "contact_reach_cases" USING btree ("payer_id","reported_at" DESC NULLS LAST);
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on both tables.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "contact_reach_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_cases" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_cases" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_cases" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_cases" FROM service_role;--> statement-breakpoint
ALTER TABLE "contact_reach_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_attempts" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_attempts" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_attempts" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_reach_attempts" FROM service_role;

-- ==============================================================================
-- rvm_waiver_end_dates: the last day a placement-team waiver applies (#2778)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2778 (BB-D-05, owner decision 2026-11-19: do it now). A waiver of the contact cost
-- (`rvm_applicant_waivers`, #2750 item 5) used to stay on until someone cleared it by hand. It may
-- now be set with an END DATE: `ends_on` is the LAST DAY (India time) it applies. From the next
-- day the waiver frees nobody, so the quote and the open both charge the normal contact cost
-- again. Nothing is deleted: the waiver row stays as it is until a clear, or until a new waiver of
-- the same scope replaces it.
--
-- `rvm_waiver_end_dates`: ONE ROW PER DATED WAIVER (`waiver_id` is the key), written in the
-- transaction that sets the waiver and never changed; a new end date is a clear and a new set. A
-- waiver with no row runs until cleared, as before. A NEW TABLE rather than a column on
-- `rvm_applicant_waivers`, because the waiver code reads that table with bare selects and a model
-- column would be named in production before its ALTER.
--
-- ADDITIVE ONLY. One new, EMPTY table, its index and one foreign key; no existing column,
-- constraint or row moves. Nothing is seeded.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table while
-- RVM_WAIVER_END_DATES_ENABLED is off: a set that sends `ends_on` is refused and every waiver runs
-- until it is cleared. With the switch on before this file, a dated set answers 503 and the reads
-- ignore end dates (logged once). Apply every lower-numbered migration first (slot order;
-- `rvm_applicant_waivers` among them), then this, then set the switch.
--
-- LOCKS. The new table is empty. The foreign key takes a brief SHARE ROW EXCLUSIVE lock on
-- `rvm_applicant_waivers` (blocks its writes, not its reads, for the instant the constraint is
-- added; nothing to validate). Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ...
-- COMMIT;` and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0181 pattern) - a regenerate drops them. The table is registered as an `rls` entry in
-- `schema-contract.ts` and listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch RVM_WAIVER_END_DATES_ENABLED off and redeploy first; every end date is lost
-- and the waivers they bounded run until cleared):
--   DROP TABLE "rvm_waiver_end_dates";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "rvm_waiver_end_dates" (
	"waiver_id" uuid PRIMARY KEY NOT NULL,
	"payer_id" uuid NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rvm_waiver_end_dates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rvm_waiver_end_dates" ADD CONSTRAINT "rvm_waiver_end_dates_waiver_id_rvm_applicant_waivers_id_fk" FOREIGN KEY ("waiver_id") REFERENCES "public"."rvm_applicant_waivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rvm_waiver_end_dates_payer_idx" ON "rvm_waiver_end_dates" USING btree ("payer_id");
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0181 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "rvm_waiver_end_dates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_end_dates" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_end_dates" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_end_dates" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_end_dates" FROM service_role;

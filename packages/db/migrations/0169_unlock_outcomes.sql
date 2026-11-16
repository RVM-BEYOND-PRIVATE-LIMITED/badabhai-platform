-- ==============================================================================
-- 0169 - unlock_outcomes: what became of one opened contact
-- ==============================================================================
--
-- #2753 item 10, the company follow-up. A company that opened a contact (an unlock) is asked,
-- UNLOCK_FOLLOWUP_AFTER_DAYS (default 7) after the grant, what came of it, and its answer is
-- stored here (POST /payer/unlocks/:unlockId/outcome): `hired`, `not_hired` or `still_talking`.
-- The desk writes `not_reached` when the company could not reach him (#2750; the service method
-- is in, no route yet). A `hired` answer also confirms the hire record (`hires`, 0168) when the
-- unlock names a posting and HIRE_RECORDS_ENABLED is on, in the same transaction.
--
-- ONE ROW PER UNLOCK (the primary key). A later answer replaces the earlier one
-- (`still_talking` -> `hired`); the history is on the spine (`unlock.outcome_recorded`, one per
-- real change), not in rows. These rows are what the second launch test in #2755 reads and they
-- cannot be rebuilt later, so they must be writing before the first counted week.
--
-- "DUE" IS NOT STORED. GET /payer/unlock-outcomes/due computes it at read time from
-- `unlocks.granted_at` and this row (no row, or `still_talking` answered at least the wait ago),
-- so there is no sweep and no state that can drift.
--
-- IDS ONLY. Ids, dates and closed codes: no name, phone, title or note. `tenant_payer_id` is the
-- unlock's own `payer_id` (the tenant key the unlock writer stores, ADR-0053), with no FK, as on
-- `unlocks.payer_id` itself.
--
-- KEYS AND INDEXES. `unlock_id` is the primary key and references `unlocks` ON DELETE CASCADE
-- (an unlock row is never deleted in production; this keeps a test or ops cleanup from failing).
-- `unlock_outcomes_tenant_answered_idx` (tenant_payer_id, answered_at) is the per-company weekly
-- read. `unlock_outcomes_worker_id_idx` backs the worker_id ON DELETE CASCADE (erasure removes a
-- worker's answers; the unlock itself survives with its worker_id set null).
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table while
-- UNLOCK_FOLLOWUP_ENABLED (default false) is off: both routes are a 404 and the desk method
-- writes nothing. With the switch on before 0169, the due list and every answer fail (42P01) and
-- answer 500; nothing is written. Apply 0164 to 0168 first (slot order), then this.
--
-- LOCKS. CREATE TABLE is instant, but each FOREIGN KEY takes SHARE ROW EXCLUSIVE on its parent -
-- `unlocks` and `workers` - which blocks writes to them while it waits behind a long
-- transaction. Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and
-- retry on 55P03 (the 0129 / 0130 / 0166 / 0167 / 0168 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0168 pattern) - a regenerate drops them silently. Registered
-- as `0169-unlock-outcomes-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the e2e RLS
-- spine.
--
-- ROLLBACK (switch off and redeploy first; the answers are lost - nothing else holds them, and
-- the spine keeps only their history):
--   DROP TABLE "unlock_outcomes";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at is
-- this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "unlock_outcomes" (
	"unlock_id" uuid PRIMARY KEY NOT NULL,
	"tenant_payer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"answered_by" text NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unlock_outcomes_outcome_chk" CHECK ("unlock_outcomes"."outcome" IN ('hired', 'not_hired', 'still_talking', 'not_reached')),
	CONSTRAINT "unlock_outcomes_answered_by_chk" CHECK ("unlock_outcomes"."answered_by" IN ('company', 'desk'))
);
--> statement-breakpoint
ALTER TABLE "unlock_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unlock_outcomes" ADD CONSTRAINT "unlock_outcomes_unlock_id_unlocks_id_fk" FOREIGN KEY ("unlock_id") REFERENCES "public"."unlocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlock_outcomes" ADD CONSTRAINT "unlock_outcomes_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unlock_outcomes_tenant_answered_idx" ON "unlock_outcomes" USING btree ("tenant_payer_id","answered_at");--> statement-breakpoint
CREATE INDEX "unlock_outcomes_worker_id_idx" ON "unlock_outcomes" USING btree ("worker_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0168 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "unlock_outcomes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_outcomes" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_outcomes" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_outcomes" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "unlock_outcomes" FROM service_role;

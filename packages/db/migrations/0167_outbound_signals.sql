-- ==============================================================================
-- 0167 - outbound_signals: a mark BadaBhai owes another system, sent once
-- ==============================================================================
--
-- #2747 item 8 (ADR-0064 §3.6). A company marks an RVM student selected or hired;
-- PayerApplicantStagesService queues one row here IN THE STAGE TRANSACTION, and the
-- OutboundSignalsSender sweep posts it to RVM's Student API
-- (POST /internal/campus/selection-events, Scheduler_Backend#162 item 8) with back-off
-- and a dead-letter state. RVM de-duplicates on the row id (event_id).
--
-- IDS ONLY. `payload` holds the posting kind and id, the worker id, the stage and the
-- IST day of the mark. The body (student ref, company, job title) is built at send time:
-- a company posting's own `org_label` (the name Campus shows students), or an agency
-- job's owner name decrypted from `payers`, so no company name is ever stored here.
-- `last_failure` is a closed code, never a response body. Not PII.
--
-- STILL TRUE WHEN SENT. A row is due ten minutes after the mark; before sending, the sender
-- re-reads the stage, the worker and his link, and cancels a mark that was undone, a worker
-- suspended or scheduled for deletion, or a link that ended (`mark_undone`,
-- `worker_inactive`, `link_inactive`).
--
-- ONCE. `dedupe_key` is unique (destination, posting, worker, stage).
--
-- KEYS AND INDEXES. `outbound_signals_due_idx` is the sweep read (pending rows by
-- next_attempt_at). `outbound_signals_worker_id_idx` backs the worker_id ON DELETE
-- CASCADE (erasure removes a worker's signals).
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this
-- table while OUTBOUND_SIGNALS_ROLLOUT (feature key `outbound_signals`, default off)
-- is off: the stage transaction queues nothing and the sweep claims nothing. With the
-- switch on for a company before 0167, its selected / hired marks on RVM students fail
-- (42P01): the stage transaction rolls back, nothing is written, the request answers
-- 500. Apply 0164, 0165 and 0166 first (slot order), then this.
--
-- LOCKS. CREATE TABLE is instant, but the FOREIGN KEY takes SHARE ROW EXCLUSIVE on
-- `workers`, which blocks writes to it while it waits behind a long transaction. Apply by
-- hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03
-- (the 0129 / 0130 / 0166 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 pattern) - a regenerate drops them silently. Registered as
-- `0167-outbound-signals-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the
-- e2e RLS spine.
--
-- ROLLBACK (switch off first; queued rows are lost - they are marks not yet sent):
--   DROP TABLE "outbound_signals";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose
-- created_at is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "outbound_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_signals_dedupe_key_uq" UNIQUE("dedupe_key"),
	CONSTRAINT "outbound_signals_destination_chk" CHECK ("outbound_signals"."destination" IN ('rvm_selection_events')),
	CONSTRAINT "outbound_signals_kind_chk" CHECK ("outbound_signals"."kind" IN ('applicant_selected', 'applicant_hired')),
	CONSTRAINT "outbound_signals_status_chk" CHECK ("outbound_signals"."status" IN ('pending', 'delivered', 'dead', 'cancelled')),
	CONSTRAINT "outbound_signals_attempts_chk" CHECK ("outbound_signals"."attempts" >= 0),
	CONSTRAINT "outbound_signals_payload_chk" CHECK (jsonb_typeof("outbound_signals"."payload") = 'object'),
	CONSTRAINT "outbound_signals_failure_chk" CHECK ("outbound_signals"."last_failure" IS NULL OR "outbound_signals"."last_failure" IN ('not_configured', 'timeout', 'network', 'http_status', 'contract', 'not_available', 'rejected', 'link_inactive', 'context_missing', 'mark_undone', 'worker_inactive', 'abandoned')),
	CONSTRAINT "outbound_signals_delivered_chk" CHECK (("outbound_signals"."status" = 'delivered') = ("outbound_signals"."delivered_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "outbound_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbound_signals" ADD CONSTRAINT "outbound_signals_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_signals_due_idx" ON "outbound_signals" USING btree ("next_attempt_at") WHERE "outbound_signals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbound_signals_worker_id_idx" ON "outbound_signals" USING btree ("worker_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "outbound_signals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "outbound_signals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "outbound_signals" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "outbound_signals" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "outbound_signals" FROM service_role;

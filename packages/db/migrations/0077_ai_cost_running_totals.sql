-- ===========================================================================
-- 0077 — AI COST ATTRIBUTION: three running-total tables
--
-- The data foundation for "what does one worker / one profiling session / the platform
-- cost us in AI spend". No UI and no endpoint ships with it — it is instrumentation.
--
-- FULLY ADDITIVE. Three NEW tables, empty on arrival. Nothing is dropped, nothing is
-- renamed, no shipped column changes meaning, and no existing read or write touches
-- them. An app deployed against an UNMIGRATED database keeps working in every respect
-- except that `AiCostRecorder.record()` cannot write a total.
--
-- ORDER: this is NOT apply-before-deploy — BECAUSE OF THE SAVEPOINT, not because the
-- write is optional. `AiCostRecorder.record()` runs the accrual inside a SAVEPOINT on the
-- event's transaction and catches its failure, so against an unmigrated database the
-- upsert's `relation "platform_ai_cost_totals" does not exist` rolls back to the
-- savepoint and the `ai.cost_recorded` row still COMMITS. Without it the error would
-- abort the enclosing transaction, Postgres would execute the eventual COMMIT as a
-- ROLLBACK, and EVERY cost event on every surface would vanish silently for as long as
-- the app ran ahead of this file. If that savepoint is ever removed, this migration
-- becomes apply-before-deploy. Apply it whenever; the sooner it applies, the less spend
-- goes uncounted. Deploying the app first costs accuracy, not uptime and not the ledger.
--
-- TIMING (the DDL itself, as distinct from deploy ORDER). The three ADD CONSTRAINT ...
-- FOREIGN KEY statements below take SHARE ROW EXCLUSIVE on `workers` (twice) and
-- `chat_sessions`, which CONFLICTS with the ROW EXCLUSIVE every ordinary write holds.
-- Validation is instant — the new tables are empty — but the lock request queues behind
-- any in-flight transaction on those two hot tables, and every writer that arrives while
-- it waits queues behind IT. `0073` set this precedent, so it is guidance rather than a
-- blocker: run under `SET lock_timeout = '3s';` and retry on 55P03 (lock_not_available)
-- instead of letting the worker write path stall behind a long-running reader.
--
-- WHY MATERIALIZED AND NOT SUMMED ON READ — see the header of
-- packages/db/src/schema/ai-cost.ts. Short version: the only expression index on
-- `ai_jobs` is partial on `job_type='profile_extraction'` and leads on `session_id`, so a
-- worker-keyed aggregate is a sequential scan of an append-only table with no retention
-- policy; and `events` has no payload index at all. Both get slower every day the
-- platform works.
--
-- BACKFILL: NONE, DELIBERATELY. These tables start empty and accrue from this migration
-- forward. Spend already on the event spine (`events WHERE event_name =
-- 'ai.cost_recorded'`) is NOT counted, so every figure derived from them means "since
-- 0077" until a backfill is separately authorised and run. A backfill is a data change
-- over the largest table in the system and belongs in a re-runnable script with an
-- owner's sign-off, not in a schema migration.
--
-- RLS. The FORCE + REVOKE tail below is HAND-APPENDED, mirroring 0073/0076: drizzle-kit
-- models ENABLE but neither FORCE nor the grant revocations, and without FORCE the table
-- OWNER bypasses every policy — which is the only connection the backend ever uses, so
-- ENABLE alone would be decorative. `platform_ai_cost_totals` carries no worker linkage
-- at all and is locked anyway, because the posture in this database is table-DEFAULT
-- rather than opt-in (see the note on the pack tables in tests/e2e/rls-spine.e2e.test.ts).
--
-- ROLLBACK. Drop the three tables, in any order — no other table has an FK to them, no
-- view or function selects from them, and their own FKs and indexes go with them. Safe
-- with the app LIVE: the only code that touches them is `AiCostTotalsRepository`, whose
-- single caller runs inside the savepoint above, so a drop degrades cost accrual to one
-- warn per AI call and changes nothing else. The event spine is unaffected, so a later
-- re-apply plus a backfill reconstructs every figure exactly:
--   DROP TABLE IF EXISTS "worker_ai_cost_totals";
--   DROP TABLE IF EXISTS "session_ai_cost_totals";
--   DROP TABLE IF EXISTS "platform_ai_cost_totals";
-- All three are also listed in LOCKED_TABLES in tests/e2e/rls-spine.e2e.test.ts, which
-- asserts RLS+FORCE+no-grants per NAME — remove those entries in the same change.
--
-- MIGRATION SLOT. 0077 is the head of the `0077`-`0079` block MIGRATIONS.md reserves for
-- Prakash. Claimed in this same change (see the table in MIGRATIONS.md), per that file's
-- own rule that a claim is recorded in the PR that takes it.
-- ===========================================================================
CREATE TABLE "platform_ai_cost_totals" (
	"provider" text NOT NULL,
	"task_type" text NOT NULL,
	"total_cost_inr" numeric(16, 6) DEFAULT '0' NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"real_call_count" integer DEFAULT 0 NOT NULL,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ai_cost_totals_pkey" PRIMARY KEY("provider","task_type"),
	CONSTRAINT "platform_ai_cost_totals_nonneg_chk" CHECK ("platform_ai_cost_totals"."total_cost_inr" >= 0),
	CONSTRAINT "platform_ai_cost_totals_counts_chk" CHECK ("platform_ai_cost_totals"."call_count" >= 0 AND "platform_ai_cost_totals"."real_call_count" >= 0 AND "platform_ai_cost_totals"."real_call_count" <= "platform_ai_cost_totals"."call_count")
);
--> statement-breakpoint
ALTER TABLE "platform_ai_cost_totals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session_ai_cost_totals" (
	"chat_session_id" uuid PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"total_cost_inr" numeric(16, 6) DEFAULT '0' NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"real_call_count" integer DEFAULT 0 NOT NULL,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_ai_cost_totals_nonneg_chk" CHECK ("session_ai_cost_totals"."total_cost_inr" >= 0),
	CONSTRAINT "session_ai_cost_totals_counts_chk" CHECK ("session_ai_cost_totals"."call_count" >= 0 AND "session_ai_cost_totals"."real_call_count" >= 0 AND "session_ai_cost_totals"."real_call_count" <= "session_ai_cost_totals"."call_count")
);
--> statement-breakpoint
ALTER TABLE "session_ai_cost_totals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_ai_cost_totals" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"total_cost_inr" numeric(16, 6) DEFAULT '0' NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"real_call_count" integer DEFAULT 0 NOT NULL,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_ai_cost_totals_nonneg_chk" CHECK ("worker_ai_cost_totals"."total_cost_inr" >= 0),
	CONSTRAINT "worker_ai_cost_totals_counts_chk" CHECK ("worker_ai_cost_totals"."call_count" >= 0 AND "worker_ai_cost_totals"."real_call_count" >= 0 AND "worker_ai_cost_totals"."real_call_count" <= "worker_ai_cost_totals"."call_count")
);
--> statement-breakpoint
ALTER TABLE "worker_ai_cost_totals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_ai_cost_totals" ADD CONSTRAINT "session_ai_cost_totals_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ai_cost_totals" ADD CONSTRAINT "session_ai_cost_totals_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_ai_cost_totals" ADD CONSTRAINT "worker_ai_cost_totals_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_ai_cost_totals_worker_idx" ON "session_ai_cost_totals" USING btree ("worker_id");--> statement-breakpoint
-- HAND-APPENDED (see the RLS note in this file's header). FORCE + REVOKE ALL for all
-- three tables, so the lock is a real denial on every PostgREST Data-API role rather
-- than an ENABLE the owner walks straight through.
ALTER TABLE "worker_ai_cost_totals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_ai_cost_totals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_ai_cost_totals" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_ai_cost_totals" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_ai_cost_totals" FROM service_role;--> statement-breakpoint
ALTER TABLE "session_ai_cost_totals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "session_ai_cost_totals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "session_ai_cost_totals" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "session_ai_cost_totals" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "session_ai_cost_totals" FROM service_role;--> statement-breakpoint
ALTER TABLE "platform_ai_cost_totals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "platform_ai_cost_totals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "platform_ai_cost_totals" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "platform_ai_cost_totals" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "platform_ai_cost_totals" FROM service_role;
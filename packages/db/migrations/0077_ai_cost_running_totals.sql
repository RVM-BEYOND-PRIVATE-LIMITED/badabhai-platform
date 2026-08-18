-- ===========================================================================
-- 0077 — AI COST ATTRIBUTION: three running-total tables
--
-- The data foundation for "what does one worker / one profiling session / the platform
-- cost us in AI spend". No UI and no endpoint ships with it — it is instrumentation.
--
-- FULLY ADDITIVE. Three NEW tables, empty on arrival. Nothing is dropped, nothing is
-- renamed, no shipped column changes meaning, and no existing read or write touches
-- them. An app deployed against an UNMIGRATED database keeps working in every respect
-- except that `AiCostRecorder.record()` cannot write a total — and that path already
-- swallows its own failures by design (cost observability must never fail the work it
-- observes), so the failure mode is a logged warning, not a broken request.
--
-- ORDER: this is NOT apply-before-deploy. Apply it whenever; the sooner it applies, the
-- less spend goes uncounted. Deploying the app first only costs accuracy, never uptime.
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
-- ROLLBACK. Drop the three tables, in any order — nothing references them, and their FKs
-- and indexes go with them. The event spine is unaffected, so a later re-apply plus a
-- backfill reconstructs every figure exactly:
--   DROP TABLE IF EXISTS "worker_ai_cost_totals";
--   DROP TABLE IF EXISTS "session_ai_cost_totals";
--   DROP TABLE IF EXISTS "platform_ai_cost_totals";
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
CREATE INDEX "worker_ai_cost_totals_cost_idx" ON "worker_ai_cost_totals" USING btree ("total_cost_inr" DESC NULLS LAST);--> statement-breakpoint
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
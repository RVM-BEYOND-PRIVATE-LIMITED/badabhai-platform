-- ADR-0035 — AI job-posting chat + cross-device drafts (payer surface).
--
-- ADDITIVE + backward-compatible. No existing table, column, type, FK, or constraint
-- is altered. Three NEW tables:
--   * payer_job_posting_chat_sessions — the conversation container (payer-side sibling
--     of chat_sessions). conversation_state/draft are loose jsonb; status is pinned by
--     CHECK to ('active','draft_ready','published','abandoned').
--   * payer_job_posting_chat_messages — the transcript (payer-side sibling of
--     chat_messages). payer_id is DENORMALIZED so ownership (assertPayerOwns) is
--     checkable without joining the session table, exactly like chat_messages.worker_id.
--   * payer_form_drafts — a GENERIC cross-device payer form-draft primitive with NO
--     consumer in this slice by design (ADR-0035 §Decision 1 forward scaffolding); the
--     chat persists its draft in its own `draft` column, not here.
--
-- PRIVACY (invariant #2): no raw PII. The payer is referenced only by the opaque
-- payers.id; payer contact PII (email/phone/org name) stays encrypted on the `payers`
-- row (ADR-0004) and is never copied here. `body_text` is payer-typed free text ABOUT A
-- JOB — it must NEVER reach an event payload, ai_jobs, audit_logs, or a log line (the
-- job_posting_chat.* events carry ids/enums/message_type only), and it is pseudonymized
-- fail-closed (invariant #3) before any LLM call.
--
-- ERASURE / referential integrity: sessions + messages + form drafts all CASCADE from
-- payers, and messages CASCADE from sessions — deleting a payer erases the whole chat
-- surface in one DELETE with no new leg in any deletion service.
-- published_job_posting_id is ON DELETE SET NULL on purpose: deleting a posting must not
-- destroy the conversation that produced it.
--
-- ROLLBACK (safe — nothing reads or writes these tables until the ADR-0035 NestJS module
-- ships; drop child-first, per ADR-0035 §Consequences):
--   DROP TABLE "payer_job_posting_chat_messages";
--   DROP TABLE "payer_job_posting_chat_sessions";
--   DROP TABLE "payer_form_drafts";
--   DROP INDEX IF EXISTS "applications_applied_idx";                 -- only if the
--   DROP INDEX IF EXISTS "jobs_status_trade_city_created_at_idx";    -- drift-reconcile
--                                                                    -- below is undone too
-- No existing table, column, or constraint is touched, so rollback cannot affect the
-- worker profiling chat, the worker chat tables, or the manual job-posting path.
CREATE TABLE "payer_form_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"form_type" text NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payer_form_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payer_job_posting_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"message_type" text DEFAULT 'text' NOT NULL,
	"body_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payer_job_posting_chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payer_job_posting_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"conversation_state" jsonb,
	"draft" jsonb,
	"published_job_posting_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "payer_job_posting_chat_sessions_status_chk" CHECK ("payer_job_posting_chat_sessions"."status" IN ('active', 'draft_ready', 'published', 'abandoned'))
);
--> statement-breakpoint
ALTER TABLE "payer_job_posting_chat_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_form_drafts" ADD CONSTRAINT "payer_form_drafts_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_job_posting_chat_messages" ADD CONSTRAINT "payer_job_posting_chat_messages_session_id_payer_job_posting_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."payer_job_posting_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_job_posting_chat_messages" ADD CONSTRAINT "payer_job_posting_chat_messages_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_job_posting_chat_sessions" ADD CONSTRAINT "payer_job_posting_chat_sessions_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_job_posting_chat_sessions" ADD CONSTRAINT "payer_job_posting_chat_sessions_published_job_posting_id_job_postings_id_fk" FOREIGN KEY ("published_job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_form_drafts_payer_form_uq" ON "payer_form_drafts" USING btree ("payer_id","form_type");--> statement-breakpoint
CREATE INDEX "payer_job_posting_chat_messages_session_id_idx" ON "payer_job_posting_chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "payer_job_posting_chat_messages_payer_id_idx" ON "payer_job_posting_chat_messages" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX "payer_job_posting_chat_sessions_payer_id_idx" ON "payer_job_posting_chat_sessions" USING btree ("payer_id");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- PRE-EXISTING DRIFT RECONCILE (not ADR-0035 — flagged, not hidden).
-- These two indexes were added to schema.ts in commit ad897b2 (Tier-1 tech-debt batch,
-- TD56/69/79/94/104/111/115) WITHOUT a generated migration, so no migration/snapshot on
-- main ever carried them (verified: absent from every migrations/*.sql and from
-- meta/0049_snapshot.json). `pnpm db:generate` for ADR-0035 therefore swept them into
-- this file. They are kept here on purpose: deleting them would leave schema.ts and the
-- 0050 snapshot permanently out of sync with the DB, and no future generate would ever
-- re-emit them. Both are pure additive CREATE INDEX — no table shape changes, no data
-- rewrite. `IF NOT EXISTS` so any environment where they were created by hand still
-- applies cleanly. NOTE for the applier: CREATE INDEX takes a SHARE lock (blocks writes
-- to `applications` / `jobs` for the build); on a large remote DB, build them out-of-band
-- with CREATE INDEX CONCURRENTLY first, then this migration is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "applications_applied_idx" ON "applications" USING btree ("worker_id","job_id") WHERE "applications"."action" = 'applied';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_trade_city_created_at_idx" ON "jobs" USING btree ("status","trade_key","city","created_at");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20): FORCE RLS + REVOKE ALL for every Data-API role on
-- the three new tables. drizzle-kit emits ENABLE only (above); FORCE + REVOKE are
-- hand-appended here the same way 0048 (agency_kyc/payouts), 0045 (push_deliveries),
-- 0029 (worker_devices/worker_credentials) and 0009 carried them. No policies exist, so
-- with FORCE these tables are deny-by-default for every client-facing role; the backend
-- reaches them with the service-role connection and PayerAuthGuard + assertPayerOwns are
-- the app-layer tenancy control. DB-enforced per-payer RLS policies remain the open-GA
-- launch gate (infra/supabase/rls-plan.md). All three are registered in the
-- tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES no-drift guard.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "payer_job_posting_chat_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_sessions" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_sessions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_sessions" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_sessions" FROM service_role;--> statement-breakpoint
ALTER TABLE "payer_job_posting_chat_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_messages" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_messages" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_messages" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_job_posting_chat_messages" FROM service_role;--> statement-breakpoint
ALTER TABLE "payer_form_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_form_drafts" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_form_drafts" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_form_drafts" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_form_drafts" FROM service_role;

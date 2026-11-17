-- ==============================================================================
-- 0168 - worker_activity: the days a worker was active, one row per IST day
-- ==============================================================================
--
-- #2753 items 4 and 7. ONE DEFINITION OF "LAST ACTIVE". Until now there were three: the
-- applicant card's band from `worker_devices.last_seen_at`, the candidate-search order's
-- later of that and `workers.updated_at`, and the daily `worker.active` event (one per UTC
-- day). `last_seen_at` moves only when a device registers (an OTP login), so a worker who
-- uses the app every day reads as last seen the day he signed in. This table records the
-- day he actually used it: WorkerActivityInterceptor writes it on any signed-in worker
-- request (app use, an apply and a reply to a company all pass through it), and
-- CampusApplicationsService on a Campus application. Every write is fire-and-forget,
-- `ON CONFLICT DO NOTHING`, and never fails the request it rides on.
--
-- The API's one read (`WorkerActivityRepository.lastActiveDays`) is the later of this
-- table's newest day and the IST day of the newest device sighting, so the history from
-- before the table needs NO BACKFILL. It feeds the #2747 pre-pay fact `lastActiveOn`, the
-- agency referred-workers list, and the `notRecentlyActive` mark on applicant and search
-- rows (more than NOT_RECENTLY_ACTIVE_DAYS, default 90, since that day).
--
-- IDS ONLY. A worker id and a date (`active_on`, the Asia/Kolkata calendar day). No route,
-- IP, device, session or time of day: with any of those this would be a movement trace
-- instead of a daily-active fact. `created_at` is never shown. Not PII.
--
-- KEYS AND INDEXES. PRIMARY KEY (`worker_id`, `active_on`) is the write's idempotency
-- (one row per worker per day, across every process and restart) and the read's index
-- (newest day per worker). Its `worker_id` prefix backs the worker_id ON DELETE CASCADE
-- (erasure is `WorkersRepository.hardDelete`, which deletes the workers row), so there is
-- no second index.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table
-- while WORKER_ACTIVITY_ENABLED (default off) is off: no write, no read, and every response
-- is today's. With the switch on before 0168, NOTHING ANSWERS 500: the activity writes
-- are lost silently (fire-and-forget), and the reads catch 42P01 and fall back to the
-- device day (the IST day of the newest worker_devices.last_seen_at), so a company's
-- applicant lists, its inbox, candidate search and an agency's referred-workers list keep
-- working and the not-recently-active mark is computed from that day. The API logs ONE
-- warning per process naming this migration. Every day of activity until 0168 is applied
-- is lost for good, which is why it still goes in first.
-- Apply 0164, 0165, 0166 and 0167 first (slot order), then this.
--
-- LOCKS. CREATE TABLE is instant, but the FOREIGN KEY takes SHARE ROW EXCLUSIVE on
-- `workers`, which blocks writes to it while it waits behind a long transaction. Apply by
-- hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03
-- (the 0129 / 0130 / 0166 / 0167 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 pattern) - a regenerate drops them silently. Registered
-- as `0168-worker-activity-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the
-- e2e RLS spine.
--
-- ROLLBACK (switch off first, then redeploy - the API reads it at boot; recorded days are
-- lost, and the last-active day falls back to the device sighting):
--   DROP TABLE "worker_activity";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose
-- created_at is this entry's journal `when`). The DROP removes the FK's triggers on
-- `workers`, so run it in the same locked transaction and retry on 55P03.
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "worker_activity" (
	"worker_id" uuid NOT NULL,
	"active_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_activity_pkey" PRIMARY KEY("worker_id","active_on")
);
--> statement-breakpoint
ALTER TABLE "worker_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_activity" ADD CONSTRAINT "worker_activity_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "worker_activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_activity" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_activity" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_activity" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_activity" FROM service_role;

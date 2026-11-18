-- ==============================================================================
-- 0173 - still_looking_checks: the monthly "still looking?" check
-- ==============================================================================
--
-- #2753 item 5. A daily sweep opens one check (`prompted_at`, no answer) for each worker who
-- is `active`, not scheduled for deletion, holds an unrevoked latest consent, has no open
-- check, and whose last check was prompted AND answered more than STILL_LOOKING_EVERY_DAYS
-- (default 30) ago, or who has none; it emits `worker.still_looking_prompted`. The worker
-- answers with one tap (POST /workers/me/still-looking): `yes`, `not_now` or `hired`, and
-- `worker.still_looking_answered` is emitted in the same transaction. With no check open
-- (an answer from Settings) the route opens and answers one row at once. "not now" takes him
-- out of company search (`worker_search_exits`, via `monthly_check`) and "yes" brings him
-- back, when SEARCH_EXIT_ENABLED is on. "hired" is stored only: a hire record needs a
-- company and a posting, which the worker desk links later.
--
-- ONE OPEN CHECK PER WORKER. `still_looking_checks_open_uq` (unique on worker_id WHERE
-- answered_at IS NULL) is the sweep's insert target (ON CONFLICT DO NOTHING), so two sweeps
-- racing open one check, never two.
--
-- IDS, TIMES AND A CLOSED CODE ONLY: no name, phone, device or free text. Not PII beyond the
-- worker id. `still_looking_checks_answered_chk` keeps `answer` and `answered_at` together.
--
-- KEYS AND INDEXES. `still_looking_checks_worker_prompted_idx` (worker_id, prompted_at) is
-- every per-worker read (the open check, the latest check, the sweep's window) and backs the
-- worker_id ON DELETE CASCADE (erasure removes a worker's checks).
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table
-- while STILL_LOOKING_CHECK_ENABLED (default false) is off: both routes are a 404 and the
-- sweep reads nothing. With the switch on before 0173, both routes answer 503 and the sweep
-- logs one warning per process and opens nothing; nothing is written. Apply 0164 to 0172
-- first (slot order), then this.
--
-- LOCKS. CREATE TABLE is instant, but the FOREIGN KEY takes SHARE ROW EXCLUSIVE on `workers`,
-- which blocks writes to it while it waits behind a long transaction. Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03 (the 0129 / 0130 /
-- 0166 / 0167 / 0170 / 0171 / 0172 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0170 / 0171 / 0172 pattern) - a regenerate drops them
-- silently. Registered as `0173-still-looking-checks-rls` in `schema-contract.ts`; listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch off and redeploy first; the answers are lost - the spine keeps their
-- history, and a "not now" exit stays in `worker_search_exits` until he turns search back on):
--   DROP TABLE "still_looking_checks";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "still_looking_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"prompted_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "still_looking_checks_answer_chk" CHECK ("still_looking_checks"."answer" IS NULL OR "still_looking_checks"."answer" IN ('yes', 'not_now', 'hired')),
	CONSTRAINT "still_looking_checks_answered_chk" CHECK (("still_looking_checks"."answer" IS NULL) = ("still_looking_checks"."answered_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "still_looking_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "still_looking_checks" ADD CONSTRAINT "still_looking_checks_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "still_looking_checks_open_uq" ON "still_looking_checks" USING btree ("worker_id") WHERE "still_looking_checks"."answered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "still_looking_checks_worker_prompted_idx" ON "still_looking_checks" USING btree ("worker_id","prompted_at");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "still_looking_checks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "still_looking_checks" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "still_looking_checks" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "still_looking_checks" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "still_looking_checks" FROM service_role;

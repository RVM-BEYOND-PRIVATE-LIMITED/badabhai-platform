-- ==============================================================================
-- 0168 - worker_search_exits: a worker who left company search
-- ==============================================================================
--
-- #2753 item 6. A worker turns "companies can find me" off (`PUT
-- /workers/me/search-visibility` with `{ visible: false }`): one row here takes him out of
-- every company's candidate search (CandidateSearchRepository's pool: the search, its city
-- facet and the admin card read), and a company he did NOT apply to can no longer open his
-- contact from an id it kept from an earlier search page (POST /payer/unlocks answers the
-- neutral unavailable). A company he applied to still opens him, and a company already
-- holding an open contact keeps it. `{ visible: true }` deletes the row: he is back.
--
-- CONSENT IS UNTOUCHED. Leaving search writes no consent row; withdrawing consent stays the
-- stronger exit. His own job feed, applying, chat and the applicant lists of companies he
-- applied to are not affected.
--
-- IDS ONLY. `worker_id`, the time he left (`hidden_at`) and a closed code (`via`: `worker`,
-- his own switch; `monthly_check`, written by a later part when he answers "not now").
-- Not PII.
--
-- KEYS. `worker_id` is the PRIMARY KEY (one exit per worker; a repeat "leave" keeps the first
-- `hidden_at`). Its FOREIGN KEY cascades on worker deletion (erasure: WorkersRepository.hardDelete
-- deletes the workers row), and the primary key's own index backs that cascade, so no second
-- index is needed.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves. A side
-- table rather than a `workers.search_hidden_at` column, so this is not an ALTER on a hot table.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table
-- while SEARCH_EXIT_ENABLED (default off) is off: the two worker routes are a plain 404, the
-- search statement is byte-identical to the one before #2753 and the unlock path reads
-- nothing. With the switch on before 0168 nothing answers 500, and the READERS FAIL OPEN
-- (nobody can have left search without this table, because leaving writes it): company
-- search, its city facet and the admin candidate card re-run the switch-off statement on
-- 42P01 (one warning per process), and the unlock gate probes
-- to_regclass('public.worker_search_exits') first and names the table only when it exists,
-- so the unlock transaction is never aborted. The two worker routes, the WRITE path, answer
-- 503 until this is applied. Apply 0164, 0165, 0166 and 0167 first (slot order), then this.
--
-- LOCKS. CREATE TABLE is instant, but the FOREIGN KEY takes SHARE ROW EXCLUSIVE on `workers`,
-- which blocks writes to it while it waits behind a long transaction. Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on 55P03 (the 0129 / 0130 /
-- 0166 / 0167 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 pattern) - a regenerate drops them silently. Registered as
-- `0168-worker-search-exits-rls` in `schema-contract.ts`; listed in LOCKED_TABLES in the e2e
-- RLS spine.
--
-- ROLLBACK (switch off first; every worker who left search is back in it):
--   DROP TABLE "worker_search_exits";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose
-- created_at is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "worker_search_exits" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	"via" text NOT NULL,
	CONSTRAINT "worker_search_exits_via_chk" CHECK ("worker_search_exits"."via" IN ('worker', 'monthly_check'))
);
--> statement-breakpoint
ALTER TABLE "worker_search_exits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_search_exits" ADD CONSTRAINT "worker_search_exits_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "worker_search_exits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_search_exits" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_search_exits" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_search_exits" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_search_exits" FROM service_role;

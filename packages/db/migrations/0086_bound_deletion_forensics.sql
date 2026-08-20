-- ===========================================================================
-- 0086 — #1110: declare the deletion trail, stop it capturing statement text and IP,
--        and give it a retention window it can actually be swept on.
--
-- OWNER DECISION, 2026-08-21, and this file is its implementation:
--
--   > "keep the DPDP erasure proof, but do not retain raw statement text/operator IP
--   >  indefinitely... define a bounded retention policy for deletion forensics; remove
--   >  unnecessary query/forensics exposure if it is not required by the approved erasure/audit
--   >  design; preserve the actual DPDP erasure proof/tombstone mechanism."
--
-- That answers the three questions #1110's investigation was scoped not to answer: the trail was
-- deliberate, it stays, and it is bounded. A mechanism that stays must be DECLARED — otherwise a
-- fresh database silently does not have it and `db:audit:live-drift` goes on reporting a
-- question that has been settled.
--
-- ===========================================================================
-- WHAT THIS DOES NOT TOUCH — THE ERASURE PROOF ITSELF
-- ===========================================================================
-- Stated first because it is the instruction most easily broken by accident. The approved DPDP
-- erasure mechanism is THREE things, and this migration touches NONE of them:
--
--   1. `audit_logs WHERE action = 'worker.erasure_executed'` — the proof row (TD58 / #712),
--      written by `ErasureAuditRepository` BEFORE the hard delete. Counts, prefixes and a closed
--      set of outcomes; never a key, path, phone or transcript.
--   2. the Redis cool-down tombstone on the PII-free `phone_hash` blind index, with a TTL.
--   3. the `worker.account_deleted` event — counts and flags only, opaque `actor_id`.
--
-- No table, column, index, constraint or function belonging to any of the three appears below.
--
-- ===========================================================================
-- `query` AND `client_addr` — DROPPED, AND WHY THAT IS ANSWERABLE RATHER THAN A JUDGEMENT CALL
-- ===========================================================================
-- The instruction was conditional: remove them *"if it is not required by the approved
-- erasure/audit design"*. It is not, and that was checked rather than assumed —
-- `ErasureAuditRepository`'s own contract is prefixes, counts and outcomes, and it keeps neither
-- statement text nor IP. Nothing else in this repository reads `_delete_forensics` at all.
--
-- What they were:
--   * `query`       = `current_query()`, the whole statement text. A parameterised delete
--                     carries no values; a hand-typed `DELETE FROM workers WHERE phone_e164 =
--                     '+91…'` carries them verbatim, into a record that OUTLIVES the row it
--                     describes — the exact thing "raw PII must never appear in audit records"
--                     forbids, and worse than a log line because a log rotates and this did not.
--   * `client_addr` = the operator's IP. Personal data under DPDP.
--
-- IRREVERSIBLE, AND THE MEASUREMENT IS WHAT MAKES IT SAFE NOW. Dropping a column destroys its
-- 147 values and no backup of this table is declared anywhere. On 2026-08-20 every row was
-- counted, never printed: **0 phone-shaped, 0 email-shaped, and none of the 35 quoted ten-digit
-- literals is a bare Indian mobile.** So the drop destroys no realised PII — and it is cheapest
-- today, because "clean" is a property of how deletes have happened so far, not of the
-- mechanism.
--
-- WHAT IS LOST, PLAINLY: network-level attribution for a console deletion. What survives still
-- identifies it — `txid`, `table_name`, `row_id`, `worker_id`, `db_user`, `app_name`,
-- `backend_pid`. Measured, all 147 rows are `postgres` via `supabase/dashboard`.
--
-- ===========================================================================
-- RETENTION — THE INDEX IS HERE, THE POLICY IS IN CODE
-- ===========================================================================
-- `_delete_forensics_at_idx` exists for exactly one consumer: `db:prune:delete-forensics`, whose
-- predicate is an age comparison on `at`. Without it the sweep is a sequential scan of a table
-- that only ever grows.
--
-- THE POLICY DELIBERATELY DOES NOT LIVE IN THE DATABASE. `pg_cron` is not installed here
-- (`pg_extension` has no row for it), and installing it to schedule this would put the policy
-- back OUT OF BAND — an invisible object doing invisible work, which is the precise shape of the
-- finding this migration closes. The sweep is a repo runner: `opsGuard`-gated, dry-run by
-- default, tested, and visible in a diff.
--
-- IT LANDS INERT. Measured 2026-08-21: oldest row 2026-08-13, and **0 rows exceed 90 days**. The
-- first sweep deletes nothing, which is the cheapest possible way to introduce a retention
-- policy — the mechanism is proved before it ever removes anything.
--
-- ===========================================================================
-- FRESH DATABASE vs PRODUCTION — one file, both correct
-- ===========================================================================
-- FRESH: `CREATE TABLE IF NOT EXISTS` builds the table WITHOUT the two columns, the function and
-- both triggers are created, and the lock is applied. The mechanism finally exists somewhere
-- other than production, which is what "declared" means.
--
-- PRODUCTION: the table already exists, so the CREATE is a no-op and the two `DROP COLUMN IF
-- EXISTS` statements do the narrowing. `CREATE OR REPLACE FUNCTION` rewrites the trigger function
-- in place. `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER` makes the triggers idempotent —
-- Postgres has no `CREATE TRIGGER IF NOT EXISTS`.
--
-- ORDER MATTERS AND IS NOT COSMETIC: the function is replaced BEFORE the columns are dropped. The
-- old body inserts into `query` and `client_addr`; dropping those first would leave a window —
-- however short, inside one transaction — in which any DELETE on `workers` fires a function
-- referencing columns that no longer exist. Replacing first means the function never references
-- a dropped column at any point.
--
-- ROLLBACK, HONESTLY. The columns cannot be restored with their data; `ALTER TABLE ... ADD COLUMN
-- query text` restores the shape and nothing else. The function, triggers, index and lock are all
-- reversible. This is the one migration in the #1110 set that is not fully undoable, which is why
-- it is separate from 0085 and why the PII measurement above is stated in full.
-- ===========================================================================

-- ── 1 ── the table, for every database that does not have it ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public._delete_forensics (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"txid" bigint,
	"table_name" text NOT NULL,
	"row_id" uuid,
	"worker_id" uuid,
	"db_user" text,
	"app_name" text,
	"backend_pid" integer
);

-- ── 2 ── the trigger function, WITHOUT the two columns. Replaced BEFORE the drop. ────────────
CREATE OR REPLACE FUNCTION public._log_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  rec jsonb := to_jsonb(old);
begin
  -- NO `query` AND NO `client_addr`. See this migration's header: neither is required by the
  -- approved erasure/audit design, and both are the reason #1110 was a privacy finding.
  insert into public._delete_forensics
    (txid, table_name, row_id, worker_id, db_user, app_name, backend_pid)
  values (
    txid_current(),
    tg_table_name,
    (rec ->> 'id')::uuid,
    case when tg_table_name = 'workers'
         then (rec ->> 'id')::uuid
         else (rec ->> 'worker_id')::uuid
    end,
    current_user,
    current_setting('application_name', true),
    pg_backend_pid()
  );
  return old;
end
$function$;

-- ── 3 ── narrow the live table. No-op where the columns were never created. ──────────────────
ALTER TABLE public._delete_forensics DROP COLUMN IF EXISTS "query";
--> statement-breakpoint
ALTER TABLE public._delete_forensics DROP COLUMN IF EXISTS "client_addr";
--> statement-breakpoint

-- ── 4 ── the triggers, idempotently ──────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS "_t_log_del_workers" ON public.workers;
--> statement-breakpoint
CREATE TRIGGER "_t_log_del_workers"
  AFTER DELETE ON public.workers
  FOR EACH ROW EXECUTE FUNCTION public._log_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "_t_log_del_worker_profiles" ON public.worker_profiles;
--> statement-breakpoint
CREATE TRIGGER "_t_log_del_worker_profiles"
  AFTER DELETE ON public.worker_profiles
  FOR EACH ROW EXECUTE FUNCTION public._log_delete();
--> statement-breakpoint

-- ── 5 ── the retention index. The sweep's only predicate. ────────────────────────────────────
CREATE INDEX IF NOT EXISTS "_delete_forensics_at_idx" ON public._delete_forensics USING btree ("at");
--> statement-breakpoint

-- ── 6 ── the house lock: ENABLE + FORCE + revoke every Data-API role ─────────────────────────
-- Already true on production (0082 swept it), and NOT true on a fresh database, where the table
-- has just been created and `ensure_rls` does not exist to enable RLS behind our back. Stating
-- all three conditions explicitly is what makes the lock identical everywhere.
ALTER TABLE public._delete_forensics ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public._delete_forensics FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public._delete_forensics FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  role_name text;
  roles     text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  FOREACH role_name IN ARRAY roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public._delete_forensics FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

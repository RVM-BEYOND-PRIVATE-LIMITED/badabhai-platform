-- ==============================================================================
-- campus_drive_request_erasures: the erasure signal Campus reads for a deleted drive request,
-- and the company delete it makes safe to let work (#2811)
-- ==============================================================================
--
-- (The header and every hand-written statement below carry no migration number of their own, so a
-- regenerate under another slot keeps them word for word: re-prepend this header and re-apply the
-- parts listed under HAND-WRITTEN.)
--
-- WHY (owner gate on #2811, Divyanshu 14 Nov 2026 and Prakash 15 Nov 2026). The QA company delete
-- (`POST /payer/me/delete/immediate`) fails for every verified company, because four foreign keys
-- to `payers` are NO ACTION. The owners ruled it must NOT be fixed until a company delete also
-- leaves RVM's Campus an erasure signal for each of the company's campus-drive requests, in the
-- same transaction: `campus_drive_requests.payer_id` is ON DELETE CASCADE, Campus keeps a copy of
-- each request's contact person (name and phone, ADR-0063 ruling R3), and today Campus drops that
-- copy only when the feed serves the request with `contact: null`, which needs the row to exist.
--
-- WHAT, IN THIS ORDER (one file, so the order is the owners' required order):
--
--   1. `campus_drive_request_erasures`: ONE ROW PER DELETED REQUEST. `request_id` uuid PK (NO FK:
--      the request row is gone), `erased_at` timestamptz DEFAULT clock_timestamp(). Nothing else:
--      no company id, no contact, FACELESS BY CONSTRUCTION. Index (`erased_at`, `request_id`), the
--      feed's keyset. RLS ENABLE + FORCE and the four REVOKEs.
--   2. A TRIGGER: `campus_drive_requests_erasure_trg`, AFTER DELETE ON `campus_drive_requests` FOR
--      EACH ROW, inserting (OLD.id, clock_timestamp()) ON CONFLICT (request_id) DO NOTHING. A
--      database trigger, not application code, so EVERY delete path leaves the tombstone in the
--      deleting transaction: the cascade from `payers` (a company delete), a raw SQL delete, any
--      future code. If the insert fails, the delete fails: no request leaves without its signal.
--      SECURITY DEFINER with a pinned search_path (the 0086 / 0088 house style), so the insert does
--      not depend on the deleting role's grants; EXECUTE revoked from PUBLIC and the Data-API roles
--      (a trigger function cannot be called directly anyway; `db:audit:undeclared-routines --strict`
--      reads the grant). The function's owner (the role that applies migrations, the app's role)
--      must bypass RLS, exactly as the app's own reads of every FORCEd table already require.
--   3. FOUR FOREIGN KEYS to `payers` go from NO ACTION to ON DELETE CASCADE, same names:
--      `employer_profiles_payer_id_fkey`, `agency_profiles_payer_id_fkey`,
--      `payer_capabilities_payer_id_fkey`, `payer_member_invites_payer_id_fkey` (all from 0084).
--      Each: DROP CONSTRAINT, ADD CONSTRAINT ... NOT VALID, VALIDATE CONSTRAINT. After this,
--      `payer_orgs.root_payer_id` (RESTRICT) is the only foreign key that can still refuse a
--      `payers` delete, and the QA delete removes a solo org first (a shared one is a 409).
--
-- NO SWITCH. Because (1)+(2) and (3) ship in ONE migration, a company delete can start working
-- only once the tombstone exists: before this file it fails (23503) exactly as today and leaves
-- nothing half-done (the QA delete is one transaction); after it, it succeeds and leaves one
-- erasure per request. There is no order in which the delete works without the signal.
--
-- DEPLOY ORDER - SAFE EITHER WAY. The code may deploy before this file is applied: the feed reads
-- the erasures table and treats a missing table (42P01) as no erasures, and the delete keeps
-- failing on the foreign keys until the file is applied. Apply every lower-numbered migration
-- first (slot order), then this.
--
-- APPLY ONLY ONCE CAMPUS READS `erased` (the jobportal side of #2811). Applying is what lets a
-- company delete run. An erasure recorded while Campus still ignores `erased` is kept, but Campus's
-- incremental pull (`changed_since` = its newest `changed_at` minus two minutes) moves past it, so
-- Campus would only learn of it from a full read (no `changed_since`). If the file is applied
-- first, Campus must do one full read when its reader ships.
--
-- LOCKS. The new table is empty. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- `campus_drive_requests` (blocks its writes, not its reads). Each foreign-key swap takes ACCESS
-- EXCLUSIVE on its own table (`employer_profiles`, `agency_profiles`, `payer_capabilities`,
-- `payer_member_invites`: at most one row per company, the last two empty on production) and
-- SHARE ROW EXCLUSIVE on `payers` (blocks payer writes, e.g. a sign-in stamp, not reads). In one
-- transaction every lock is held to COMMIT, so NOT VALID + VALIDATE shortens nothing here; it is
-- kept so each step is the house pattern if the swap is ever hand-applied in parts. The validate
-- scans tables of a few hundred rows at most. Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout (55P03).
--
-- HAND-WRITTEN (`drizzle-kit generate` emits the table, ENABLE, the index and a plain foreign-key
-- drop and add, nothing else): this header; FORCE and the four REVOKEs (the 0117 / 0156 / 0181 /
-- 0192 pattern); the function, its REVOKEs and the trigger (drizzle does not model triggers); the
-- `NOT VALID` + `VALIDATE` split; the statement order. The table is registered as an `rls` entry
-- in `schema-contract.ts` and listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (every erasure recorded is lost, and Campus keeps the contacts of the companies deleted
-- in the meantime: tell Campus first). In ONE transaction, the foreign keys FIRST, so there is no
-- window in which a company delete works without the trigger:
--   ALTER TABLE "employer_profiles" DROP CONSTRAINT "employer_profiles_payer_id_fkey";
--   ALTER TABLE "employer_profiles" ADD CONSTRAINT "employer_profiles_payer_id_fkey" FOREIGN KEY
--     ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
--   (the same for agency_profiles, payer_capabilities and payer_member_invites), then
--   DROP TRIGGER "campus_drive_requests_erasure_trg" ON "campus_drive_requests";
--   DROP FUNCTION public.campus_drive_request_erasure_record();
--   DROP TABLE "campus_drive_request_erasures";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at is
-- this entry's journal `when`). There is no switch to turn off.
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE / FUNCTION / TRIGGER). Apply once.
-- ==============================================================================
CREATE TABLE "campus_drive_request_erasures" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"erased_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus_drive_request_erasures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "campus_drive_request_erasures_feed_idx" ON "campus_drive_request_erasures" USING btree ("erased_at","request_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0181 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "campus_drive_request_erasures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_request_erasures" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_request_erasures" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_request_erasures" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_request_erasures" FROM service_role;--> statement-breakpoint
-- ===========================================================================
-- THE TOMBSTONE TRIGGER - HAND-WRITTEN (drizzle does not model triggers).
-- One row per deleted request, in the deleting transaction, whatever deleted it.
-- ===========================================================================
CREATE FUNCTION public.campus_drive_request_erasure_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
begin
  -- The id and the time only: never the company, the contact or anything else from OLD.
  insert into public.campus_drive_request_erasures (request_id, erased_at)
  values (old.id, clock_timestamp())
  on conflict (request_id) do nothing;
  return old;
end
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campus_drive_request_erasure_record() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campus_drive_request_erasure_record() FROM anon;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campus_drive_request_erasure_record() FROM authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campus_drive_request_erasure_record() FROM service_role;--> statement-breakpoint
CREATE TRIGGER "campus_drive_requests_erasure_trg"
  AFTER DELETE ON public.campus_drive_requests
  FOR EACH ROW EXECUTE FUNCTION public.campus_drive_request_erasure_record();
--> statement-breakpoint
-- ===========================================================================
-- THE FOUR FOREIGN KEYS: NO ACTION -> ON DELETE CASCADE, same names. LAST, so the
-- delete they unblock can only run with the trigger above already in place.
-- ===========================================================================
ALTER TABLE "employer_profiles" DROP CONSTRAINT "employer_profiles_payer_id_fkey";
--> statement-breakpoint
ALTER TABLE "employer_profiles" ADD CONSTRAINT "employer_profiles_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "employer_profiles" VALIDATE CONSTRAINT "employer_profiles_payer_id_fkey";--> statement-breakpoint
ALTER TABLE "agency_profiles" DROP CONSTRAINT "agency_profiles_payer_id_fkey";
--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD CONSTRAINT "agency_profiles_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agency_profiles" VALIDATE CONSTRAINT "agency_profiles_payer_id_fkey";--> statement-breakpoint
ALTER TABLE "payer_capabilities" DROP CONSTRAINT "payer_capabilities_payer_id_fkey";
--> statement-breakpoint
ALTER TABLE "payer_capabilities" ADD CONSTRAINT "payer_capabilities_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payer_capabilities" VALIDATE CONSTRAINT "payer_capabilities_payer_id_fkey";--> statement-breakpoint
ALTER TABLE "payer_member_invites" DROP CONSTRAINT "payer_member_invites_payer_id_fkey";
--> statement-breakpoint
ALTER TABLE "payer_member_invites" ADD CONSTRAINT "payer_member_invites_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payer_member_invites" VALIDATE CONSTRAINT "payer_member_invites_payer_id_fkey";

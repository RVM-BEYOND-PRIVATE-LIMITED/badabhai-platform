-- Lock workers PII to the backend service role only (review follow-up to 0003).
--
-- 0003 enabled RLS on workers, but RLS alone never constrains a BYPASSRLS role,
-- and Supabase ships client-facing roles reachable over the network:
--   * service_role — PostgREST's Data API (/rest/v1/workers) connects as this and
--     has BYPASSRLS, so the service-role key could read the encrypted phone_e164 /
--     phone_hash / full_name over HTTPS.
--   * anon / authenticated — the other Data API roles.
-- The real control for a BYPASSRLS role is removing the grant, so we REVOKE from
-- every client-facing role + PUBLIC and FORCE RLS (so even the table owner is
-- subject to policies; there are none -> deny by default).
--
-- The backend is unaffected: it connects on a DIRECT Postgres connection as the
-- `postgres` role (BYPASSRLS) and never via the Data API. Verified: nothing in
-- this repo uses PostgREST. (SET ROLE anon/authenticated/service_role -> 42501;
-- GET /rest/v1/workers with the service-role key -> HTTP 403.)
ALTER TABLE "workers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM service_role;

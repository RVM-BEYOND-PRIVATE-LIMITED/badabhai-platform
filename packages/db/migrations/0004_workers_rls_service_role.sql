-- Close the remaining read path to workers PII (review follow-up to 0003).
--
-- 0003 enabled RLS + revoked anon/authenticated, but that did NOT stop the
-- Supabase `service_role`: PostgREST's Data API (/rest/v1/workers) connects as
-- service_role, which has BYPASSRLS — so with the service-role key the encrypted
-- phone_e164 / phone_hash / full_name were still readable over HTTPS. RLS alone
-- never constrains a BYPASSRLS role; the real control is removing the grant.
-- (Verified: nothing in this repo uses the Supabase Data API — the backend uses
-- the direct Postgres connection as the `postgres` role, which is unaffected.)
ALTER TABLE "workers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM service_role;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "workers" FROM PUBLIC;

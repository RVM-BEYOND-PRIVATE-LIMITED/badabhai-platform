-- ===========================================================================
-- Supabase Storage buckets — OUT-OF-BAND provisioning (NOT a Drizzle migration)
-- ===========================================================================
-- WHY this is not in packages/db/migrations: the Drizzle migration chain also runs
-- against plain Postgres in CI/local (docker `postgres` / `pgvector`), which has NO
-- Supabase `storage` schema. A migration touching `storage.buckets` would break
-- `pnpm db:migrate` there. Storage is a Supabase-only concern, so it lives here and
-- is applied DIRECTLY to the Supabase project.
--
-- Idempotent: safe to re-run. It also RE-ASSERTS privacy if a bucket drifted public.
--
-- APPLY (Supabase project only):
--   psql "$SUPABASE_DB_URL" -f infra/supabase/storage-buckets.sql
--   # or paste into the Supabase dashboard SQL editor
-- See infra/supabase/storage-buckets.md for the full runbook + verification.
-- ===========================================================================

-- worker-resumes — rendered resume PDFs (TD5 / ADR-0007). The PDF bytes contain the
-- worker's REAL NAME, so the bucket MUST be PRIVATE: the only read path is a
-- short-TTL signed URL minted by the backend (service_role). Launch gate R13.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('worker-resumes', 'worker-resumes', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public             = false,                       -- enforce PRIVATE even if it drifted
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- interview-kits — rendered per-trade interview-kit PDFs (Task 4). These contain NO
-- PII (kits are per-trade, never per-worker), but the bucket is still PRIVATE: the
-- only read path is a short-TTL signed URL minted by the backend. Object keys are
-- `interview-kits/{tradeKey}/v{contentVersion}/interview-kit.pdf` (render-once).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('interview-kits', 'interview-kits', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public             = false,                       -- enforce PRIVATE even if it drifted
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Access model: a PRIVATE bucket (public = false) has NO public/anon read path.
-- `storage.objects` is RLS-enabled by Supabase; we add NO permissive policy for the
-- anon/authenticated roles, so every direct read is denied (deny-by-default). The
-- backend reads/writes with the service_role key (which bypasses RLS) and hands
-- clients ONLY short-TTL signed URLs (RESUME_SIGNED_URL_TTL_SECONDS).
-- DO NOT add an anon/authenticated SELECT policy on storage.objects for this bucket.

-- NOTE: `worker-conversations` (ADR-0003, risk R10) needs the same private treatment,
-- but it is a separate feature's launch gate — provision it the same way when closing
-- R10, e.g.:
--   insert into storage.buckets (id, name, public, allowed_mime_types)
--   values ('worker-conversations', 'worker-conversations', false, array['application/json'])
--   on conflict (id) do update set public = false;

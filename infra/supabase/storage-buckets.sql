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

-- worker-profile-photos — worker profile photos (ADR-0032). A face photo is a
-- HIGH-SENSITIVITY PII class: the bucket MUST be PRIVATE — the only write path is a
-- short-TTL signed UPLOAD url minted by the backend (server-chosen opaque key
-- `photos/{workerId}/{uuid}.jpg`), and the only read path is a short-TTL signed URL
-- for the worker's OWN photo. NEVER payer-readable (the faceless invariant).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('worker-profile-photos', 'worker-profile-photos', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public             = false,                       -- enforce PRIVATE even if it drifted
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- worker-voice-notes — raw recorded voice notes (ADR-0029, TD29 G2). Audio IS personal
-- data under CLAUDE.md §2: the worker is speaking, so a clip can contain their own name,
-- their employer's name, and a spoken phone number — the bucket MUST be PRIVATE. The only
-- write path is a short-TTL signed UPLOAD url minted by the backend over a SERVER-chosen
-- opaque key `voice-notes/{workerId}/{uuid}.m4a` (voice.service.ts `createUploadUrl`, which
-- re-validates that exact shape on register, so a worker cannot claim another's object);
-- the only read path is the ai-service fetching bytes with the service_role key to transcribe.
-- NEVER worker-readable, NEVER payer-readable, NEVER world-readable.
--
-- The NAME is load-bearing, not cosmetic — `worker-voice-notes` is the value documented in
-- .env.example for VOICE_NOTES_BUCKET AND the hard default baked into the ai-service
-- (apps/ai-service/app/config.py `voice_notes_bucket`). Two consumers, two defaults: if you
-- provision some OTHER name and set only the API's VOICE_NOTES_BUCKET, the API writes to your
-- bucket while the ai-service still reads `worker-voice-notes`, and every transcription fails
-- closed to an empty transcript. Keep the name, or set it in BOTH services.
--
-- R25 (issue #280) binds here: the DSAR/account-deletion sweep erases audio by iterating
-- `voice_notes.storage_path` against VOICE_NOTES_BUCKET (account-deletion.service.ts). Audio
-- that lands ANYWHERE ELSE survives a worker's deletion request — raw voice PII outliving a
-- DSAR is Critical, not cosmetic. TD58 (issue #281) is the other open edge: retention_policy
-- still defaults `retain_indefinitely` and storage_class `hot`, so once this bucket is armed
-- audio accumulates here forever with no TTL, no cold-tier lifecycle, and no orphan sweep for
-- objects uploaded but never registered. Provisioning the bucket does NOT pay TD58.
--
-- Size cap: clips are hard-capped at 120s by the recorder (record_package_voice_recorder.dart
-- `defaultMaxDuration`); AAC-LC mono at the package default 128kbps ≈ 1.9MB, so 5MiB is ~2.5x
-- headroom while still bounding an abusive PUT against a minted url.
-- MIME: the shipped client PUTs `audio/mp4` (voice_pipeline_impl.dart) — AAC-LC in an .m4a
-- container. The two m4a aliases are listed because some HTTP stacks substitute them for the
-- same bytes, and Supabase rejects the upload outright on a content-type miss (the victim is a
-- worker whose recorded note 400s at the PUT with nothing actionable on screen).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('worker-voice-notes', 'worker-voice-notes', false, 5242880,
        array['audio/mp4', 'audio/m4a', 'audio/x-m4a'])
on conflict (id) do update
  set public             = false,                       -- enforce PRIVATE even if it drifted
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- NOTE: `worker-conversations` (ADR-0003, risk R10) needs the same private treatment,
-- but it is a separate feature's launch gate — provision it the same way when closing
-- R10, e.g.:
--   insert into storage.buckets (id, name, public, allowed_mime_types)
--   values ('worker-conversations', 'worker-conversations', false, array['application/json'])
--   on conflict (id) do update set public = false;

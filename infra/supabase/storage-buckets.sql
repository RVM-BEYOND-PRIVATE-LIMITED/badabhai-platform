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

-- worker-feedback-attachments — the images a worker attaches to a FEEDBACK submission
-- (#1191). Personal data in the same class as the message they arrive with: a worker
-- photographs what is in front of them, which is routinely a payslip, a gate pass, a
-- supervisor, or their own face — so the bucket MUST be PRIVATE. The only write path is a
-- short-TTL signed UPLOAD url minted by the backend over a SERVER-chosen opaque key
-- `feedback-attachments/{workerId}/{uuid}.jpg` (feedback.service.ts
-- `createAttachmentUploadUrl`, whose submit step re-validates that exact shape against the
-- SESSION worker, so one worker cannot claim another's object); the only read path is a
-- short-TTL signed GET minted per admin page view. NEVER payer-readable, NEVER world-readable.
--
-- A SEPARATE BUCKET FROM `worker-profile-photos`, DELIBERATELY. A face photo the worker chose
-- as their profile picture and a photograph of a broken screen are different sensitivity
-- classes that will want different retention and different mime rules; one bucket would fuse
-- those two decisions permanently. The account-deletion sweep records them as two legs for the
-- same reason.
--
-- ⚠ `allowed_mime_types` IS A SECURITY CONTROL HERE, NOT HYGIENE — this is the one bucket
-- whose objects are LINKED TO AND CLICKED by a human on an internal console. A signed upload
-- url cannot constrain what the client PUTs, and this feature deliberately has no confirm step
-- (a submit-time `getObjectInfo` would sit inside the transaction carrying the worker's typed
-- message). So THIS LIST is what stops a worker storing `text/html` that an admin's click
-- would then render on the storage origin. The admin surface asks for
-- `Content-Disposition: attachment` on the signed GET as a second layer; this is the first.
-- `image/jpeg` only: the shipped Flutter client re-encodes every pick to JPEG and the server's
-- minted key ends `.jpg`, so anything else is already refused one layer up.
--
-- Size cap: 5 MiB, matching FEEDBACK_ATTACHMENT_MAX_BYTES. THE BUCKET IS WHERE THAT CEILING IS
-- ENFORCED — Supabase refuses the PUT itself, before any of our code runs. The config value
-- exists so the number has one name in the repo, and is deliberately NOT read on the submit
-- path (see its own note in packages/config/src/server.ts).
--
-- DSAR: `AccountDeletionService` sweeps the `feedback-attachments/{workerId}/` prefix against
-- this bucket. The prefix sweep is load-bearing rather than belt-and-braces here, because with
-- no confirm step an object whose submission was never sent is referenced by NO row at all —
-- which is exactly why the key is worker-scoped instead of flat.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('worker-feedback-attachments', 'worker-feedback-attachments', false, 5242880,
        array['image/jpeg'])
on conflict (id) do update
  set public             = false,                       -- enforce PRIVATE even if it drifted
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- RETIRED: `worker-conversations` — DO NOT PROVISION.
--
-- ADR-0003 planned this bucket as an archival mirror of each finished interview. It was
-- WITHDRAWN on 2026-08-14 without ever being built: this insert was commented out for the
-- bucket's entire existence, and nothing ever wrote `chat_sessions.conversation_storage_path`.
--
-- `chat_messages` holds the complete verbatim transcript already, so provisioning this now
-- would create a SECOND copy of raw worker PII behind an object ACL that can drift — which
-- was precisely risk R10. R10 is Closed BY the retirement; un-commenting this would reopen it.
--
-- `CONVERSATIONS_BUCKET` still exists in server config and still names this bucket, because
-- `AccountDeletionService` sweeps `conversationWorkerPrefix(worker_id)` against it on erasure.
-- That sweep is defence in depth and is correct against a bucket that does not exist: the
-- Storage `list` 404s and the leg records `nothing_to_delete`.
--
-- Reviving archival needs a NEW ADR (see ADR-0003's Withdrawal section), not this comment.

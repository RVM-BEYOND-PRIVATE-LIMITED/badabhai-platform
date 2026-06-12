# Row Level Security (RLS) Plan — TODO, NOT finalized in Phase 1

> ⚠️ **Phase 1 does not finalize production RLS.** During Phase 1 the NestJS
> backend connects with the Supabase **service role** and is the only client that
> reads/writes these tables. No untrusted client connects directly yet. This
> document is the plan to implement before any direct-client access (Phase 2+).

## Principles

- Workers may access **only their own** data.
- Ops/admin access goes through the backend (service role), never raw client keys.
- The `events` table is **insert-only** from backend services; never client-writable.
- No direct client write to sensitive tables.
- Voice-note audio lives in a private Storage bucket with its own policies.

## Per-table plan (to implement later)

| Table                | Worker (own row)        | Backend (service role) | Notes                              |
| -------------------- | ----------------------- | ---------------------- | ---------------------------------- |
| `workers`            | read own (later)        | full                   | PII; no client write in Phase 1    |
| `worker_consents`    | read own (later)        | insert/read            | append-only; revoke via `revoked_at` |
| `worker_profiles`    | read own (later)        | full                   | confirm via backend                |
| `chat_sessions`      | read/insert own (later) | full                   |                                    |
| `chat_messages`      | read own; insert inbound (later) | full          | outbound written by backend        |
| `voice_notes`        | read own (later)        | full                   | audio in Storage, not in table     |
| `generated_resumes`  | read own (later)        | full                   |                                    |
| `events`             | **none**                | **insert only**        | never client-writable or readable  |
| `ai_jobs`            | **none**                | full                   | internal                           |
| `audit_logs`         | **none**                | insert only            | internal                           |

## Sketch (DO NOT enable blindly — review per environment)

```sql
-- Example shape for Phase 2+; worker identity will map to auth.uid().
-- ALTER TABLE worker_profiles ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY worker_reads_own_profile ON worker_profiles
--   FOR SELECT USING (worker_id = current_worker_id());

-- events: lock down entirely from anon/authenticated; backend uses service role
-- ALTER TABLE events ENABLE ROW LEVEL SECURITY;
-- (no SELECT/INSERT policies for anon/authenticated => effectively no access)
```

## Storage buckets

Buckets are provisioned **out-of-band** (not via the Drizzle chain — plain Postgres in
CI/local has no `storage` schema). See [storage-buckets.md](storage-buckets.md) +
[storage-buckets.sql](storage-buckets.sql).

- `worker-resumes` — **PRIVATE**, signed-URL-only (TD5 / R13); object path
  `resumes/<worker_id>/<resume_id>/v<n>.pdf`. Idempotent SQL provided.
- `worker-conversations` (ADR-0003 / R10) and `voice-notes` (later) — same private model.
- Signed URLs issued by the backend (service role); no public/anon read.

## Checklist before enabling direct client access

- [ ] Define worker auth → DB identity mapping (`current_worker_id()`)
- [ ] Enable RLS on every table and add explicit policies
- [ ] Verify `events`/`audit_logs`/`ai_jobs` are unreachable by anon/authenticated
- [x] Storage bucket policies + signed URL flow — `worker-resumes` private + signed-URL-only ([storage-buckets.md](storage-buckets.md)); `worker-conversations` / `voice-notes` pending
- [ ] Penetration test the policies

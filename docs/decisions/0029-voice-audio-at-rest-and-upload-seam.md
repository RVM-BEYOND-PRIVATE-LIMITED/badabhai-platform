# ADR-0029: Voice audio at rest + the signed-upload seam (server-issued upload URLs, owner-only transcript read, fail-closed dormancy)

- **Status:** Proposed
- **Date:** 2026-07-10
- **Scope:** `apps/api/src/voice` (new `POST /voice/upload-url`, tightened `POST /voice/upload`,
  new `GET /voice/:voiceNoteId`), `apps/api/src/storage/storage.service.ts` (a signed-**upload**-URL
  method over the existing Storage Mode A REST seam), `packages/config` (`VOICE_NOTES_BUCKET`
  activation semantics — no schema change), and `apps/worker-app` (the real recording client).
  A **companion code PR implements this on the same branch** (`feat/voice-pipeline-mock-e2e`);
  this ADR is the decision of record.
- **Relates to:** [ADR-0003](0003-worker-conversation-storage-boundary.md) (private-bucket,
  service-role-only, opaque-key storage posture this extends), [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md)
  Phase 5 / PR #169 (DSAR audio erasure already wired to `VOICE_NOTES_BUCKET`, dormant),
  TD54 (which recommended exactly this upload path: "server-minted signed upload URL →
  client-direct-to-Storage"), TD29 G2 (the worker-app voice leg), TD6 (STT wiring).
  Invariants engaged: CLAUDE.md §2 #1 (event-first), #2 (no raw PII out of boundary),
  #3 (pseudonymize fail-closed), #5 (real calls gated), #6 (consent gate), §7 (real-provider escalation).

## Context

The worker-app voice leg is hard-blocked ("A2-storage MISSING"). The backend half exists:
`POST /voice/upload` registers a **client-supplied** `storage_path` (a Phase-1 placeholder — no
real audio ever lands anywhere), and `POST /voice/transcribe` enqueues BullMQ → ai-service STT
(mock-by-default; real Sarvam is behind `AI_ENABLE_REAL_CALLS` + `SARVAM_API_KEY`). The
`voice_notes` table already carries everything needed (`storage_path`, `duration_seconds` ≤120s,
`transcript_text/confidence/english`, `retention_policy` default `retain_indefinitely`,
`storage_class`). `VOICE_NOTES_BUCKET` defaults `""` (dormant) and is wired ONLY into the
ADR-0026 Phase 5 DSAR/account-deletion erasure — a deliberate dormant launch gate.

What is missing is the **ingestion seam**: how audio bytes physically reach storage, under whose
control the object key is, and how a worker ever reads their transcript back. Three constraints
shape the answer: (a) buckets are **private, service-role-only, Storage Mode A** (REST + `fetch`,
no SDK — `storage.service.ts`, `infra/supabase/storage-buckets.md`); (b) raw audio is
worker-PII-adjacent content and must never transit systems that log bodies; (c) the current
placeholder trusts a client-chosen `storage_path` — a path-forgery hole that is safe **only**
because no real client ships today.

## Decision

### 1. Ingestion = server-issued signed upload URLs (audio never transits the API)

New **`POST /voice/upload-url`** (`WorkerAuthGuard` + `ConsentGuard`): the server mints an
**opaque, server-controlled object key** `voice-notes/{workerId}/{uuid}.m4a` in the private
`VOICE_NOTES_BUCKET` and returns `{ storage_path, upload_url, expires_in }`, where `upload_url`
is a **short-TTL signed upload URL** (a new `StorageService` method over the same Mode A REST
seam as `createSignedUrl` — the TD24 resume download-signer precedent, upload direction). The
client `PUT`s the bytes **directly to storage**. Audio bytes never transit the NestJS API and
never reach events, logs, or an LLM. The key carries only opaque UUIDs — no phone, name, or any
worker-supplied string.

### 2. `POST /voice/upload` tightens: registered path must be the caller's own prefix

The registration endpoint now rejects any `storage_path` outside the caller's own
`voice-notes/{workerId}/` prefix. This closes the client-chosen-path trust hole (registering
another worker's object, or an arbitrary bucket path). It is safe to tighten **now** — the real
client is hard-blocked today, so there is no shipped consumer to break.

### 3. New `GET /voice/:voiceNoteId` — owner-only transcript read

The only transcript retrieval path, over worker auth (`WorkerAuthGuard` + `ConsentGuard`):
returns the caller's own voice-note row (transcript text/confidence/english, status). Not-found
and not-owner are **both 404** (no existence oracle). Transcript correctly stays OUT of
`ai_jobs` result payloads and events — only length/confidence are evented (existing behavior).

### 4. Fail-closed dormancy

While `VOICE_NOTES_BUCKET` is unset (the default), `POST /voice/upload-url` returns **503** —
the feature is inert until ops provisions the private bucket out-of-band
(`infra/supabase/storage-buckets.md` pattern; re-runnable SQL re-asserts `public = false`).
Same honest UX as today's block; setting the bucket simultaneously arms the already-wired
DSAR erasure (ADR-0026 Phase 5) — no ordering gap where audio exists but erasure is dormant.

### 5. Retention: `retain_indefinitely` stays the alpha default

Revisit before GA — the schema already carries `retention_policy` + `storage_class`, so a
policy lands later without a migration. Logged as **TD58** (tech-debt register). DSAR
erase-on-request already covers the bucket once set.

### 6. Real STT stays §7-gated — this ADR does NOT flip it

Sarvam `saarika:v2.5` remains behind `AI_ENABLE_REAL_CALLS` + `SARVAM_API_KEY`, staging-first,
human-approved (§7). Mock STT returns a canned transcript so the pipeline is testable
end-to-end: record → signed upload → register → transcribe → poll → owner-only read.

### 7. Client shape

The worker app records with the `record` package (AAC-LC `.m4a`), enforces the **120s hard cap**
matching `voiceDurationSecondsSchema`, requests mic permission at runtime, and **deletes the
on-device temp file after a successful upload**.

## Privacy invariants (CLAUDE.md §2 — stated explicitly)

- **Raw audio is worker-PII-adjacent content at rest:** private bucket only, service-role-only
  access, opaque object key (no phone/name/free text in the path), never in events, `ai_jobs`,
  `audit_logs`, or logs. Signed URLs are short-TTL and never logged.
- **`transcript_text` lives ONLY on the `voice_notes` row** (same class as ADR-0003
  conversation content). Events/`ai_jobs` carry length + confidence only — unchanged.
- **Pseudonymization applies to the TRANSCRIPT** before any LLM use (the existing fail-closed
  chat path, invariant #3). The audio itself only ever goes to the STT provider, and only
  under the §7 gate. No new LLM path is introduced.
- **Consent gates everything** (invariant #6): all three routes ride `WorkerAuthGuard` +
  `ConsentGuard`; the worker identity comes from the session, never the body.
- **Event-first** (invariant #1): upload-registration and transcription keep emitting their
  existing validated PII-free events; the new mint/read endpoints add no PII-bearing payloads.

## Rollout + gates

| Step | Gate |
|---|---|
| Companion code PR (this branch) — endpoints + client, mock STT | Standard §6 quality gates + security review (PII/auth surface) |
| Bucket provisioning (staging) | Ops runs the private-bucket SQL out-of-band; verify anon-denied; set `VOICE_NOTES_BUCKET` → feature + DSAR erase arm together |
| Real STT flip | §7 human escalation: `AI_ENABLE_REAL_CALLS=true` + `SARVAM_API_KEY`, staging-first, synthetic audio |
| Retention policy | TD58 — product + security ratify a window before GA / real-volume STT |

## Consequences

- **Positive:** unblocks TD29 G2 / TD54's voice leg with the exact upload path TD54 already
  recommended; audio bytes never touch the API process (no multipart parsing, no body-logging
  risk, no memory pressure); the object-key authority moves server-side, closing the path-forgery
  hole; dormancy is fail-closed and self-consistent with the DSAR gate; everything reuses the
  existing Storage Mode A seam and signer precedent — no new SDK, stack unchanged (§3).
- **Negative / risk:** a signed upload URL is a bearer credential for one object slot — bounded
  by short TTL, server-chosen key, and a private bucket (worst case: the intended slot is
  overwritten by the token holder before expiry). The client can lie about `duration_seconds`
  or upload non-audio bytes — tolerable at alpha (mock STT; real STT provider rejects garbage);
  server-side probe/validation is a hardening follow-up, not a launch gate. Orphaned objects
  (uploaded but never registered) accumulate until a retention/lifecycle policy exists (TD58).
- **Rollback:** revert the companion PR — `POST /voice/upload` returns to placeholder semantics;
  unsetting `VOICE_NOTES_BUCKET` re-inertizes the feature at runtime (503) without a deploy.
  No schema or event-payload change is made, so nothing needs versioning to roll back.

## Alternatives considered

1. **Multipart upload through the NestJS API.** Rejected: raw audio would transit the API
   process (body parsing, buffering, interceptor/log exposure — a new §2 leak surface), and it
   duplicates what storage already does. The API should broker *authorization*, not bytes.
2. **Client-direct upload via anon key + Storage RLS policies.** Rejected: buckets are
   deliberately service-role-only Mode A (ADR-0003); there is no Storage-RLS story in this repo
   (RLS plans cover Postgres tables), and it would open a second, weaker access model to the
   most sensitive bucket.
3. **Keep the client-supplied `storage_path` placeholder.** Rejected: it is a standing
   path-forgery trust hole that only stays safe while the feature is unusable — the moment a
   real client ships, it is an IDOR-shaped bug. Tightening now costs nothing.
4. **Ship real Sarvam STT in the same change.** Rejected: real-provider keys/spend are a §7
   human escalation; the mock-first pipeline proves the seam end-to-end without it.

## Open questions (surface, do not silently decide)

1. **Transcript merge into chat history** — TD54 recommends a server-side merge via the
   `chat_messages.voice_note_id` FK + a worker chat-history fetch. `GET /voice/:voiceNoteId` is
   the alpha retrieval; the merge is a separate decision when chat history ships.
2. **Retention window + `storage_class` lifecycle** (hot→cold, purge-after-transcribe) — TD58,
   product + security + DPDP legal track, before GA.
3. **Upload validation depth** — whether to probe uploaded bytes (magic-number/duration check)
   server-side before transcription, once real STT volume justifies it.

## Related

- [ADR-0003](0003-worker-conversation-storage-boundary.md) — the private-bucket/opaque-key storage posture
- [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md) Phase 5 / PR #169 — DSAR audio erasure (dormant gate this ADR arms)
- `apps/api/src/voice/*` — the endpoints; `apps/api/src/storage/storage.service.ts` — the Mode A seam + signer precedent
- `packages/config/src/server.ts` (`VOICE_NOTES_BUCKET`, L66–74) — the dormancy flag
- `packages/db/src/schema.ts` (`voice_notes`, L406–435) — the already-sufficient schema (no migration)
- `infra/supabase/storage-buckets.md` — private-bucket provisioning runbook
- Tech-debt: **TD54** (voice client unbuilt — the un-defer trigger this ADR fires), **TD29 G2**, **TD58** (retention, new)

*This ADR records the voice-audio-at-rest architecture decision (2026-07-10): server-issued
signed upload URLs into a private service-role-only bucket, owner-only transcript read,
fail-closed dormancy behind `VOICE_NOTES_BUCKET`, mock STT end-to-end, real STT still §7-gated.*

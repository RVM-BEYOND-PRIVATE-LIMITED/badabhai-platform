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

> **Addendum (2026-07-17) — the 30–120s transport gap is closed (chunked/async STT).**
> See *Addendum: D-2* at the foot of this ADR. The decision above is unchanged; real
> provider creds remain §7.

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

---

## Addendum (2026-07-17) — D-2: 30–120s notes transcribe via chunked/async STT

**Status of this addendum:** built; provider-armed pending §7. **Trigger:** owner ruling,
[team-decisions.md](../registers/team-decisions.md) *2026-07-17 — Context-drift register
rulings*, **item 8: "D-2 (voice 30s vs 120s): BUILD IT PROPERLY = ASYNC STT"** — the async
transcription path for 30–120s notes, **not** a UI cap; real Sarvam creds remain §7. Fixes
[context-drift-2026-07-16](../registers/context-drift-2026-07-16.md) **D-2** (P1).

### The gap

§7 of this ADR promised 120s notes (`MAX_VOICE_NOTE_SECONDS = 120`, `packages/types`), but
the transport capped at 30s: `stt.py` raised *"batch STT not implemented"* above
`SARVAM_SYNC_MAX_SECONDS = 30.0`. **The product promise and the transport disagreed by 4×**,
failing closed and silently unusable. The 30s guard was also applied to the **mock** path —
fail-closed against a provider that path never calls.

### Decision — chunked sync, not the provider's batch API

Sarvam's batch/async STT contract **is not derivable from this repo** (only the sync REST
endpoint, the `saarika:v2.5` pin, and the 30s limit are known). Rather than guess a provider
API shape we cannot test, the 30–120s path is **chunked sync** — the proven pattern:

1. **Split** the stored object into <30s segments on **codec-frame boundaries**
   (`apps/ai-service/app/audio_chunk.py`).
2. **Transcribe** each segment with the *same, already-verified* sync endpoint, at bounded
   parallelism.
3. **Concatenate** deterministically **in segment order** (never completion order).

The provider seam is unchanged (`SttAdapter`), so swapping in a real batch API later is a
contained change behind the same adapter.

**Pure-python segmentation, no ffmpeg.** The ai-service has **no container image** (CI is
`setup-python`; there is no ai-service Dockerfile to add a system package to), so
segmentation must not shell out. §1 of this ADR mints exactly one format —
`voice-notes/{workerId}/{uuid}.m4a` (AAC-LC in MP4) — so the splitter parses the `moov`
sample tables and repackages each window of AAC frames as **ADTS** (`audio/aac`, already in
the upload content-type map): frame-exact, **no re-encoding**, no decoder. PCM `.wav` is
also supported. **Every other container fails closed** — never guess.

### Numbers

| Knob | Value | Why |
|---|---|---|
| `SARVAM_CHUNK_MAX_SECONDS` | **29.5s** | Frame-quantized windows stay strictly <30s (a balanced split overshoots by ≤1 AAC frame, ≤64ms). |
| Chunks for a 120s note | **5** (`ceil(120/29.5)`) | ~24s each. A 45s note → 2. |
| `SARVAM_CHUNK_CONCURRENCY` | **2** | Halves wall time, caps provider burst. 5 chunks → 3 waves. |
| Per-call httpx timeout | **60s** (unchanged) | Applies **per chunk**, not stretched across the note. |
| ai-service worst case (120s note) | **≤260s** | storage ≤20s + 3 waves × 60s + translate ≤60s. |
| `AiService.transcribe` fetch budget | **270s** (was 8s) | ≤260s + 10s overhead. **Only** this call is raised; every other AI call keeps the 8s default. |
| `sarvam_stt_cost_inr_per_chunk` | **₹0.25** (estimate) | saarika ≈ ₹30/audio-hour. **Calibrate against the invoice at the §7 flip.** |
| `MAX_CHUNKS_PER_NOTE` | **5** = `ceil(120/29.5)` | Hard ceiling on provider calls per note, independent of *both* worker-controlled inputs (declared duration AND file tables). An honest full-length note is exactly 5, so it costs nothing. |
| Worst-case note spend | **₹1.25** (5 × ₹0.25) | Under `AI_MAX_USER_DAILY_COST_INR` (₹6) ⇒ **~4 full-length notes/user/day**; each chunk call is far under the ₹10 `AI_MAX_CALL_COST_INR` ceiling (which bounds the **rate**, not the **count** — see H-1 below). |
| `_MAX_AAC_FRAMES` | **10,000** (was 20,000,000) | Memory guard, not a formality: run-length tables let a ~500 B file demand tens of millions of list slots (measured 508 B → 320 MB). An honest 120s note is 1,875 frames @16kHz. |

### ⚠️ Chunking INTRODUCES a phone-leak at chunk seams (H-2) — #392 must land first

**This addendum originally claimed a boundary-split phone "is still masked, byte-identically
to the unsplit case, test-locked". That claim was FALSE and is withdrawn.** It generalized
from the single shape the test happened to lock (a bare join-space). The truth:

- `_PHONE_RE`'s character class is `[\d\s\-]`, so it spans **only** spaces/dashes. Any other
  seam artifact breaks the digit run.
- `_RESIDUAL_DIGITS_RE = \d{7,}` does **not** fire either, because neither half is a 7-digit
  run — so the number is **not even blocked**. It reaches LLM input.
- Measured leaks: `98765. 43210` (period), `98765। 43210` (danda), comma, ellipsis — and,
  requiring no punctuation assumption at all, **one filler word**: `98765 haan 43210`.
- **Chunking is what introduces this.** An unsplit note has no seam; a 120s note has **4**.
  An STT seam is an utterance boundary, so terminal punctuation or a filler rendered from
  the clipped syllable is ordinary, not exotic.

**The fix is NOT in this PR.** [PR #392](../../) replaces `_PHONE_RE` with digit-count
normalization, closing this exact root cause (an independent reviewer found the same cause on
main via `9876.543.210`). Two concurrent edits to the pseudonymize gateway would collide, so
this branch deliberately does not touch it.

> **ORDERING DEPENDENCY — binding:** **#392 MUST merge before #395, and Sarvam MUST NOT be
> armed until it has.** The seam cases are pinned as `xfail(strict=True)` in
> `test_stt_real.py` (`_SEAM_LEAK_CASES`): they document the live gap without reddening CI,
> and the moment #392 lands they XPASS → strict turns that into a **failure**, forcing
> whoever rebases to delete the marker. That red is the intended signal.

Until #392 lands, the honest statement of the boundary is: **a phone split across a chunk
seam by anything other than a space or dash leaks to LLM input.** The mock path is
unaffected (no provider, no chunking), so nothing leaks today at the default gate.

### Invariants (verified, not assumed)

- **#3 pseudonymize fail-closed — no new bypass.** The adapter concatenates **inside**
  `_transcribe_chunked`; a chunk never escapes it, so `/profile/extract` gates the **FULL**
  transcript exactly as before (`main.py` *"1. Pseudonymize FIRST"*) — never a chunk. What
  chunking *does* change is the **content** the gate sees at seams (H-2 above), not the
  order or the fact of gating.
- **#5 real calls gated** — chunking runs only on the already-gated real path
  (`AI_ENABLE_REAL_CALLS` + `SARVAM_API_KEY`). **The mock is now duration-agnostic**: the
  30s limit is a provider-upload constraint and no longer applies to a path with no provider.
- **Fail closed, never fabricate.** ANY chunk failure fails the **whole** note to an empty
  transcript — a partial transcript with silent holes is a fabrication risk. Unsplittable
  containers, over-long containers and >120s declared notes are refused **before**
  storage/provider spend.
- **#2 no PII** — `audio_chunk.py` logs nothing; raised messages carry only box names /
  sizes / generic strings. `worker_ref` is the opaque worker UUID already sent for
  chat/extraction.

### Spend (TD68 pattern) — and why the reservation must bound the call count (H-1)

Each chunk is a billable provider call, so chunking **multiplies calls**. The real path
**reserves** on the TD27 `SpendLedger` *before* any Sarvam call (attributed to `worker_ref`'s
per-user daily budget), then **reconciles to actual**: chunks that returned before a failure
stay recorded (they were billed); only uncalled chunks are refunded. A ledger block returns an
**empty** transcript — never the mock. Mock mode does zero ledger traffic.

**The reservation bounding the call count is not automatic, and the first cut got it wrong.**
The reservation derives from the **client-declared** `duration_seconds`; the call count derives
from the **file's own container tables**. Those are two *independent* worker-controlled inputs —
the ADR-0029 signed-upload seam lets one worker choose both. Measured on the first cut: a
**~200KB `.m4a` whose tables claimed 200,000s, declared as 31s → reserved 2 chunks (₹0.50),
actually issued 6,780 Sarvam calls (₹1,695)** — blowing the per-user (₹6), daily (₹200) **and**
cumulative (₹1,000) caps inside **one request**. The per-call ceiling never trips: it bounds the
**rate**, not the **count**.

Three guards now keep them reconciled, **all before the first provider call**:

1. `_projected_chunks` reserves the **structural bound** (`MAX_CHUNKS_PER_NOTE` = 5) for any
   chunked note — *not* `ceil(declared/29.5)`. This makes **reserved ≥ actual always**, and
   avoids false-closing an honest note whose client floored the duration across a chunk
   knife-edge (declares 59s, file is really 59.5s → 2 vs 3). Mirrors `router.py`'s existing
   worst-case-reserve → reconcile-to-actual discipline; the over-reservation is refunded the
   moment the note resolves.
2. `split_audio(max_total_seconds=…)` **derives the file's real duration** from its own tables
   and refuses anything over the platform cap **at the source** — the root-cause fix (the file's
   real duration was previously never derived or cross-checked at all).
3. `_transcribe_chunked` refuses `len(segments) > min(reserved, MAX_CHUNKS_PER_NOTE)`.

Hostile-table handling is bounded too: `_MAX_AAC_FRAMES` is **10,000** (was 20,000,000 — an
honest 120s note is 1,875 frames @16kHz, ~5.6k @48kHz). The MP4 tables are run-length/implicit
encoded, so one 8-byte `stts` entry or a fixed-size `stsz` could demand tens of millions of list
slots from a ~500-byte file — **measured 508 B → 320 MB peak (~630,000:1)**, which at
`SARVAM_CHUNK_CONCURRENCY` is an OOM. Now **454 B → 2.1 KB (4.7:1)**; both parsers check the
count *before* allocating.

### Contracts + queue

`TranscriptionInput` gains an **optional** `worker_ref` (Zod ↔ Pydantic in lockstep) —
additive and backward compatible; no output shape changed, no event payload changed, no
migration. The queue path already made this async from the API's perspective (BullMQ
`VoiceTranscriptionProcessor`, off the request path, lock auto-extended) — **confirmed**;
the fix was entirely inside the ai-service handler.

### Residuals — all three gate the real-Sarvam flip

1. **#392 must merge first (H-2).** A phone split across a chunk seam by anything other than
   a space/dash leaks to LLM input. Chunking introduces the seams; #392 fixes the gateway.
   **Do not arm Sarvam before #392 is on main.**
2. **TD59 is now materially worse.** The worker-app polls ~14s for a transcript; a real 120s
   note can take ~4 minutes. Fix TD59 (server-side merge, or an adaptive poll budget) before
   the flip, or a completed transcript strands and the worker re-records an already-billed clip.
3. **The ₹0.25/chunk rate is an estimate** — calibrate against the first invoice at the §7 flip.
   Every cap number above scales off it.

Also unmeasured until the §7 staging run: cross-seam STT **accuracy** (a word split
mid-utterance). Note this is the same phenomenon as H-2 — a seam changes the text — but the
accuracy question is a quality matter, whereas H-2 is a privacy one.

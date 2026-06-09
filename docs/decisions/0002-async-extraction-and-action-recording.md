# ADR 0002 — Async Profile Extraction (BullMQ) + Generic Action Recording

- **Status:** Accepted
- **Date:** 2026-06-09
- **Phase:** 1 (Worker Profiling)
- **Supersedes:** part of TD1 (extraction moved off the request path)

## Context

Two needs converged:

1. **Close a Phase-1 `🔜` item.** The sprint plan and
   [team-decisions](../registers/team-decisions.md) prioritise moving
   extraction/transcription off the request path onto BullMQ before real STT/LLM
   are enabled (TD1). Synchronous extraction couples request latency to the AI
   call and offers no retries/backpressure.
2. **Start capturing the behavioural event stream from day one.** The moat is the
   compounding behavioural stream the Learn layer trains on. "Everything is an
   event" already holds for the profiling flow; worker *actions* (edits, resume
   downloads, voice playback, engagement) were not yet captured. They must be —
   regardless of when the Learn layer ships.

Constraint: the trade/worker taxonomy must be **data, not code** (extensibility
mandate), and **no raw PII** may ever land in the `events` table.

## Decisions

1. **Profile extraction is asynchronous via BullMQ on Redis.**
   `POST /profile/extract` now creates an `ai_job` (`queued`), emits
   `profile.extraction_requested`, enqueues a job, and returns **`202`** with
   `{ ai_job_id, status: "queued" }`. A `ProfileExtractionProcessor`
   (`@nestjs/bullmq` `WorkerHost`) does the work — build transcript → call the AI
   service (which pseudonymizes; mock fallback if down) → persist the profile →
   `markCompleted` → emit `profile.extraction_completed`. Clients **poll**
   `GET /ai-jobs/:id` until `completed` (read `output_ref.profile_id`) or
   `failed` (`error_message`).
2. **Terminal failures stay in the event stream.** New event
   `profile.extraction_failed` is emitted once, on the **last** retry attempt
   (BullMQ `attempts: 3`, exponential backoff), or immediately if enqueue fails.
3. **The processor is idempotent.** If an `ai_job` is already `completed` (e.g.
   BullMQ stalled-job redelivery), the processor returns the recorded
   `profile_id` without reprocessing — no duplicate profiles.
4. **Enqueue failure is terminal, not orphaning.** If `queue.add` throws (Redis
   down), `extract()` marks the job `failed`, emits `profile.extraction_failed`,
   and returns `503` — so every `requested` is balanced by a `completed`/`failed`.
5. **Generic, events-only action recorder.** A single `action.recorded` event
   carries a controlled `action_type` (an `ACTION_TYPES` list — *data*, extend to
   add actions) + bounded non-PII `context`. `POST /actions` and
   `POST /actions/batch` (≤100, one DB round-trip via `EventsService.emitMany`,
   for offline-tolerant clients flushing buffered actions). **No new table** —
   actions are appended to the `events` spine (subject + actor = the worker).
6. **Fail-closed PII guard at the action boundary.** Client-supplied `context`
   (keys and string values) is rejected if it looks like a phone or email,
   on top of the bounded schema. Best-effort: `context` is for non-PII signals;
   it is **not** a free-text sink (names/addresses are not pattern-detectable).
7. **In-process worker for Phase 1.** The processor runs inside the API process.
   The queue boundary lets it split into a dedicated worker process later with no
   contract change.

## Consequences

- **Positive:** extraction no longer blocks the request; retries/backoff for free;
  failures are observable as events; the behavioural stream is captured from day
  one; actions extend as data (extensibility mandate); no schema migration.
- **Negative / risks:**
  - The API now has a **hard Redis dependency** for the extraction path (Redis is
    already in the stack + docker-compose).
  - **Contract change:** `/profile/extract` is `202 + poll` (was `201 + body`).
    The Flutter `ApiClient` was updated to enqueue+poll but is **unverified** (no
    Flutter SDK in the build env — needs `flutter analyze` in CI). See TD13.
  - In-process worker shares the API's resources (acceptable at MVP scale; TD12).
  - Residual: a partial-success retry (profile created, then `markCompleted`
    fails) could still duplicate a profile; the idempotency guard covers the
    common redelivery case. A true fix needs an `ai_job_id` column on
    `worker_profiles` or a transaction (deferred; TD14).
- **Privacy:** verified by the security gate — job data and `action.recorded`
  payloads carry only ids/enums/bounded context; `GET /ai-jobs/:id` exposes only
  refs (`profile_id`) and an error string. No new PII path to events or an LLM.

## Status of related debt

- **TD1** (extraction inline): extraction is **paid down**; **transcription**
  remains inline (no STT contract yet) — TD1 stays open for transcription only.

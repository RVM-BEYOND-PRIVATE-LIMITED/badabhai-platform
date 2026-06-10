# @badabhai/event-schema

**Artifact #1.** The canonical contract for every event the BadaBhai platform
emits. Event-first architecture means *every important endpoint emits an event*,
and *every event validates against this schema*.

## Why this package exists first

Events are the spine of the system. Defining them before any service guarantees
that the API, AI service, and future consumers all speak the same language and
that we never persist an event we can't later parse.

## Concepts

- **Envelope** (`envelope.ts`) — common fields wrapping every event: `event_id`,
  `event_name`, `event_version`, `occurred_at`, `actor`, `subject`, `source`,
  `correlation_id`, `causation_id`, `payload`, `metadata`.
- **Registry** (`registry.ts`) — the single source of truth mapping each
  `event_name` to its current `version` + Zod `payload` schema.
- **Payloads** (`payloads.ts`) — per-event payload schemas.
- **Validation** (`validate.ts`) — `validateEvent`, `assertValidEvent`,
  `createEvent`, and the fully-typed `BadaBhaiEvent<N>` / `AnyBadaBhaiEvent` types.

## Privacy rules (enforced by review)

Payloads carry **IDs and hashes, never raw PII**. No raw phone, full name,
address, employer name, or ID-doc tokens may appear in any event. Use `*_hash`
or opaque UUIDs. This keeps the events table safe to query, export, and replay.

## Usage

```ts
import { createEvent, validateEvent } from "@badabhai/event-schema";

// Build a validated event (ids + timestamp auto-generated):
const event = createEvent({
  event_name: "worker.otp_requested",
  actor: { actor_type: "worker" },
  subject: { subject_type: "worker" },
  source: "api",
  metadata: { environment: "production", service: "api" },
  payload: { phone_hash: "…" }, // typed to worker.otp_requested's payload
});

// Validate an unknown event (e.g. read from a queue):
const result = validateEvent(unknownInput);
if (!result.success) {
  // result.error.stage ∈ "envelope" | "event_name" | "version" | "payload"
}
```

## Versioning

Phase 1 keeps one current version per event name. To change a payload
incompatibly: bump the `version` in `registry.ts` and keep older versions
available behind a versioned map. Never mutate a shipped payload schema.

## Scripts

```bash
pnpm --filter @badabhai/event-schema build      # tsc -> dist
pnpm --filter @badabhai/event-schema typecheck  # tsc --noEmit (incl. tests)
pnpm --filter @badabhai/event-schema test       # vitest
```

## Phase-1 event names (25)

`worker.created` · `worker.otp_requested` · `worker.otp_verified` ·
`consent.accepted` · `chat.session_started` · `chat.message_received` ·
`chat.message_sent` · `voice_note.uploaded` ·
`voice_note.transcription_requested` · `voice_note.transcription_completed` ·
`profile.extraction_requested` · `profile.extraction_completed` ·
`profile.extraction_failed` · `profile.extraction_ready` · `profile.confirmed` ·
`resume.generated` · `action.recorded` · `ai.pseudonymization_started` ·
`ai.pseudonymization_completed` · `ai.pseudonymization_failed` ·
`ai.llm_call_requested` · `ai.llm_call_completed` · `ai.llm_call_failed` ·
`ai.cost_recorded` · `ai.job_completed`

### Interview-turn contract (stateful turn + cost + extraction-ready)

`profile.extraction_ready` fires when the interview engine has gathered enough
for extraction (carries `answered_topics` ids + `turn_count`, no PII).
`ai.cost_recorded` is the cost/spend spine — it mirrors the AI service's
`AICallMetadata` (model, tokens, `estimated_cost_inr`, `cost_alert`,
`above_target`). `ai.job_completed` records async (BullMQ) `ai_jobs` lifecycle
success. These are the frozen v1 contracts downstream emitters build against.

### `action.recorded` — the behavioural stream

A single, **extensible** event carries a controlled `action_type` (see
`ACTION_TYPES` in `payloads.ts`) plus a bounded, non-PII `context`. Adding a new
worker action is a **data** change (extend `ACTION_TYPES`), never a schema
rebuild. This is the raw material for the future Learn layer. It is **not** the
employer/match feedback loop (shortlist/reject/hire/no-show) — that learning
loop is deferred with matching.

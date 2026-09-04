# ADR-0035: AI Job-Posting Chat + Cross-Device Drafts

- **Status:** Accepted (owner sign-off in planning session). This ADR is the architecture
  gate for the build; it records the design before any schema/module/event-schema code is
  written. Build order and hand-off are §Decision 7.
- **Date:** 2026-07-27
- **Phase:** Phase-2 fast-follow, additive to the existing self-serve payer/agency surface
  (ADR-0019/0022). **Not a §2 invariant relaxation.** No Reach Engine, no matching/ranking,
  no new money surface — the chat only drives the existing job-posting create path.
- **Author:** system-architect (architecture + contract). Implementation is handed to
  database-architect (migration 0050) → ai-engineer (AI-service module + contracts) →
  backend-engineer (NestJS module) → frontend-engineer / mobile-engineer (payer-web +
  payer-app, parallel, against the frozen API contract).
- **Builds on / reconciles (verified against the repo, 2026-07-27):**
  - **ADR-0019** (`docs/decisions/0019-self-serve-payer-portal.md`) — the `payers` account,
    `PayerAuthGuard` (`apps/api/src/payers/payer-auth.guard.ts`), the `assertPayerOwns`
    tenant chokepoint. **This is the account and guard we REUSE — no new auth, no new
    principal.**
  - **ADR-0012** (`docs/decisions/0012-ops-job-postings-banded-stored-only.md`) — the
    `job_postings` table, the `vacancy_band` enum (never a raw integer), and the direct
    precedent for adding a **new, distinct additive event domain** rather than overloading
    an existing one when the entity is genuinely different (there: `job_posting` vs the
    ADR-0009 `job`; here: `job_posting_chat` vs `job_posting`).
  - **ADR-0005** (`docs/decisions/0005-metadata-driven-multi-profile-profiling.md`) and the
    shipped worker profiling engine (`apps/ai-service/app/profiling/`,
    `apps/api/src/chat/`) — the interview-loop PATTERN this slice reuses: topic bank,
    `_next_topic` priority ordering, ask/clarify bounds, `MAX_ENGINE_ASKS`, a stateless
    deterministic engine with the LLM used only to rephrase/extract, never to decide.
  - **AI-PERSONA-2** (worker-name post-hoc interpolation, `apps/api/src/ai/ai.service.ts` /
    `apps/ai-service/app`) — the precedent this slice mirrors for the payer's own org name:
    interpolate the real value into the UI/output **after** the LLM call, never send it
    into LLM input or store it in conversation state/events.
  - **Chat transcript hydration** (`apps/api/src/chat/chat.controller.ts`, the #349
    endpoint) — the no-oracle 404 IDOR-defense pattern for "hydrate a past conversation by
    id" this slice's `GET /payer/job-posting-chat/sessions/:id/messages` copies.
  - **`packages/ai-contracts/src/index.ts`** — the existing `ConversationStateSchema`,
    `ProfilingTurnInputSchema`/`ProfilingTurnOutputSchema`, `WorkerProfileDraftSchema` this
    ADR's new contracts mirror (`apps/ai-service/app/contracts.py` is the Pydantic mirror,
    kept in sync by existing convention — see `packages/ai-contracts/src/ai-contracts.test.ts`).
  - **`apps/api/src/job-postings/job-postings.dto.ts`** (`PayerCreateJobPostingSchema`) and
    **`apps/api/src/job-postings/job-postings.service.ts`** (`JobPostingsService.createForPayer`,
    already emits `job_posting.created` with `actor_type: "payer"`) — the existing, unchanged
    job-creation path this slice's publish step calls directly.
  - **`packages/validators`** (`bandForCount`) — the existing integer→`vacancy_band` mapper
    this slice reuses for any vacancy-count answer given in the chat.
  - CLAUDE.md §2 invariants 1 (event-first), 2 (no raw PII outside its boundary), 3
    (pseudonymize fail-closed), 4 (LLMs assist, never decide), 6 (DPDP consent — worker-only,
    does not apply to the payer-facing surface), 7 (typed contracts), 8 (backward
    compatibility / additive-only); §7 escalation; §8 deferred scope.

---

## Context

Payers (companies posting demand directly) and agencies (`payers.role = 'agent'`) currently
create a job posting through a structured form (`PayerCreateJobPostingSchema` /
`JobPostingsService.createForPayer`). Filling that form cold — trade taxonomy, vacancy
banding, pay bands, shift, benefits, requirements — has the same "blank-page" friction that
motivated the worker-profiling chat. The product ask, already designed and approved by the
owner: give the payer the **same chat-first pattern** the worker app uses to build a
profile, but pointed at building a **job-posting draft**, on **either** `apps/payer-web` or
the payer-facing Flutter app, with the conversation **resumable on any device** — the payer
can start on the web, close the tab, and continue on the phone (or vice versa), because the
conversation state lives server-side keyed to the payer's account rather than to a device or
browser session.

The chat is explicitly a **front door onto the existing job-posting entity**, not a new
job-creation mechanism. It produces a `JobPostingDraft` that, on publish, is validated
against the same `PayerCreateJobPostingSchema` the manual form already uses and handed to
the same `JobPostingsService.createForPayer` call, which already emits `job_posting.created`
with `actor_type: "payer"`. This ADR is the wiring of a new **conversational input surface**
in front of that unchanged path — it does not touch job-posting lifecycle, pricing, boosts,
or the `job_postings`/`jobs` coexistence boundary ADR-0012 already drew.

Three architectural questions had to be settled before any code, all already decided by the
owner and recorded here:

1. Can the worker profiling engine be **reused directly** for job-posting interviews, or
   does it need a **sibling**? (§Decision 2 — sibling, because the worker engine's topic
   constants are hardcoded to worker-profiling topic ids, not parameterized.)
2. How does the chat learn the payer's own company name **without** either asking for it in
   free text (which risks a payer typing personal PII too, and duplicates data already on
   the `payers` row) or running it through a masker tuned for a different purpose? (§Decision
   3 — auto-fill server-side, post-hoc interpolation, never sent to the LLM.)
3. Does cross-device resume need a new session/identity mechanism? (§Decision 1/5 — no; it
   rides the existing `PayerAuthGuard` session, so "any device" just means "any device where
   the payer is logged into the same account.")

---

## Decision

### 1. New DB tables (migration 0050, additive only)

Three new tables, all additive — no existing table, column, or FK target is altered.

- **`payer_job_posting_chat_sessions`** — the conversation container.
  `id` (uuid, pk) · `payer_id` (uuid, FK → `payers.id`, `ON DELETE CASCADE`) · `status` (enum
  `"active" | "draft_ready" | "published" | "abandoned"`) · `conversation_state` (jsonb — the
  `JobPostingChatState`, §Decision 4) · `draft` (jsonb, nullable — the in-progress
  `JobPostingDraft`) · `published_job_posting_id` (uuid, FK → `job_postings.id`, `ON DELETE
  SET NULL`) · `started_at` / `last_message_at` / `ended_at` (timestamptz) · index on
  `payer_id`.
- **`payer_job_posting_chat_messages`** — the transcript.
  `id` (uuid, pk) · `session_id` (uuid, FK → sessions, `ON DELETE CASCADE`) · `payer_id`
  (uuid, FK → `payers.id`, `ON DELETE CASCADE` — **denormalized** onto the message row
  specifically so ownership checks (`assertPayerOwns`) don't need a join through
  `sessions` on every message read) · `direction` (enum, payer/assistant) · `message_type`
  (enum) · `body_text` (text, nullable) · `metadata` (jsonb) · `created_at` · indexes on
  `session_id` and on `payer_id`.
- **`payer_form_drafts`** — a **generic** draft-persistence primitive for **future**
  workstreams (no consumer in this slice; the job-posting chat uses its own dedicated
  `draft` jsonb column above, not this table). `id` (uuid, pk) · `payer_id` (uuid, FK →
  `payers.id`, `ON DELETE CASCADE`) · `form_type` (text) · `state` (jsonb) · `updated_at` ·
  `UNIQUE(payer_id, form_type)`.

**Why new sibling tables and not the existing `chat_sessions`/`chat_messages`:** the shipped
worker chat tables carry a **hard `NOT NULL` FK to `workers.id`** and worker-shaped
conversation-state fields. Retargeting them at a `payer_id` would mean either mutating a
shipped, in-use FK/column (invariant #8) or overloading a worker-shaped shape for a
different principal — both rejected. New, parallel, additive tables are the same choice
ADR-0012 made for `job_postings` vs the ADR-0009 `jobs` table, and ADR-0022 §d made for
`agency_invites` vs the worker-shaped `invites` table: when the existing entity's shape is
load-bearing and NOT NULL against a different principal, coexist, don't retrofit.

### 2. New AI-service module — a sibling, not a parameterization

`apps/ai-service/app/job_posting_chat/` (`question_bank.py`, `interview_engine.py`,
`prompts.py`), structurally parallel to `apps/ai-service/app/profiling/`
(`question_bank.py`, `interview_engine.py`, `prompts.py`, plus the worker-only
canonicalization/extraction modules that this sibling does not need). It reuses the
worker engine's **pattern** — a topic bank, a `_next_topic` priority-ordering function, ask
vs. clarify bounds, and a `MAX_ENGINE_ASKS` ceiling — but is a **new module**, not a
generic/parameterized rebuild of `profiling/`, because the worker engine's
`ESSENTIAL_TOPICS`/`MUST_ASK_TOPICS` are **hardcoded module-level constants** that reference
worker-profiling topic ids directly; there is no seam today to swap in a different topic
set without either forking the module or adding a topic-set parameter to every function in
it (a larger, riskier change to a shipped module, rejected in favor of a clean sibling).

New AI-service routes: `POST /job-posting-chat/opening`, `POST /job-posting-chat/respond`.
Both are gated by the **same** `pseudonymize()`-first, fail-closed call already in front of
`/profiling/respond` (`apps/ai-service/app/pseudonymize.py`, invariant #3 — **non-negotiable
and unmodified**). This applies even though the payer is describing a job, not themselves:
a payer can still type a personal phone number, their own name, or an applicant's name into
free text, and the privacy gateway does not get an exemption based on who the principal is.

### 3. Payer org name — auto-filled, never asked, never sent to the LLM

The chat **never asks for, and never sends to the LLM,** the payer's own company/org name.
It is auto-filled server-side from the already-known `payers.orgNameEnc` (decrypted
server-side, in the NestJS layer, same as every other read of that encrypted column — ADR-0004
discipline) and interpolated into the UI/draft **post-hoc**, mirroring the shipped
**AI-PERSONA-2** pattern (`apps/api/src/ai/ai.service.ts`) where the worker's real name is
interpolated into output after the LLM call and never crosses into LLM input, conversation
state, or an event payload.

**Why not run it through the existing employer-name masker:** `pseudonymize.py` already
carries an employer-name mask tuned to **redact** a worker's stated **past** employer from
LLM input — a fundamentally different job (hide a third-party name) from this one (correctly
surface the payer's own legitimate business name in a job-posting draft). Running the
existing masker over the payer's own org name would either mangle a real business name (false
positive) or require building and maintaining a second, oppositely-tuned mask profile. Not
asking for the name in free text at all sidesteps the problem structurally rather than adding
a second masking mode to a module whose one job today is redaction.

### 4. New Zod contracts (`packages/ai-contracts`, mirrored into `apps/ai-service/app/contracts.py`)

Following the existing convention (header comment on both sides states they must stay in
sync — verified by `packages/ai-contracts/src/ai-contracts.test.ts`):

- **`JobPostingChatState`** — mirrors the shape of the existing `ConversationStateSchema`.
- **`JobPostingChatTurnInput`** / **`JobPostingChatTurnOutput`** — mirror
  `ProfilingTurnInputSchema` / `ProfilingTurnOutputSchema`.
- **`JobPostingDraft`** — mirrors the existing rich-draft precedent (`WorkerProfileDraftSchema`).
  Fields: `role_title`, trade/skill phrases, `location_label`, `vacancy_band`, `pay_min`,
  `pay_max`, `shift`, `benefits`, `requirements`, `description`, `confidence`,
  `missing_fields`, `clarification_questions`. This maps **1:1** onto the existing
  `PayerCreateJobPostingSchema` (`apps/api/src/job-postings/job-postings.dto.ts`) — the
  publish step (§Decision 5) is a direct field-for-field validation against that schema, not
  a new shape.

**Vacancy answers are always banded, never a raw integer.** Any vacancy-count answer the
payer gives in the chat is passed through the existing `bandForCount()` validator
(`packages/validators`) to produce the `vacancy_band` enum value — the same enum
ADR-0012 deliberately chose over an integer. This ADR does not reopen that choice; the chat
is a new **input surface** on top of the same banded representation.

### 5. New NestJS module — `apps/api/src/payer-portal/job-posting-chat/`

Standard convention (CLAUDE.md §4): `controller.ts` (thin, HTTP only) →
`service.ts` (business logic, emits events) → `repository.ts` (Drizzle) + `dto.ts` (Zod) +
`module.ts` (DI wiring), placed alongside the other `payer-portal/payer-*` modules.

All five endpoints ride the **existing** `PayerAuthGuard` — no new guard, no new principal.
There is **no** DPDP consent gate on this surface: invariant #6 ("no profiling/AI processing
of a worker before `consent.accepted`") is scoped to **workers**; the payer-facing job-posting
chat has no worker subject and consent does not apply here.

| Endpoint | Purpose |
| --- | --- |
| `POST /payer/job-posting-chat/session` | start a new chat session for the authenticated payer |
| `POST /payer/job-posting-chat/message` | send a payer turn, get the next engine turn back |
| `GET /payer/job-posting-chat/sessions` | list this payer's in-progress/recent sessions — **the cross-device "continue where I left off" entry point**; both `apps/payer-web` and the payer-app Flutter client call this on load |
| `GET /payer/job-posting-chat/sessions/:id/messages` | hydrate a session's transcript history; same **no-oracle 404** IDOR defense pattern as the existing worker `chat.controller.ts` transcript-hydration endpoint (unknown-vs-not-owned returns an identical neutral 404) |
| `POST /payer/job-posting-chat/sessions/:id/publish` | validate the session's `draft` against `PayerCreateJobPostingSchema`, then call `JobPostingsService.createForPayer(...)` **directly** |

The publish endpoint is explicitly **not** a new job-creation code path — it is reuse of the
existing one. `createForPayer` already exists and already emits `job_posting.created` with
`actor_type: "payer"`; this slice adds no new writer of that event.

Cross-device resume falls out of this design for free: because `session_id`/`payer_id`
ownership (not a device/browser session) is what gates every read, and `GET
/payer/job-posting-chat/sessions` lists by the **authenticated payer**, any device where the
payer is logged into the same `payers` account sees the same in-progress sessions and can
resume by hydrating `:id/messages` and re-posting to `/message`.

**AiService extension, no new HTTP client class.** The existing `AiService`
(`apps/api/src/ai/ai.service.ts`), which already exposes `profilingRespond` /
`profilingOpening` / `canonicalizeSkill` via a shared private `post<T>()` HTTP helper, gets
two new methods: `jobPostingChatOpening`, `jobPostingChatRespond`. No new HTTP client is
introduced.

### 6. New event domain — `job_posting_chat`

A new, additive event **domain** (`packages/event-schema`), not an overload of the existing
`job_posting` domain — the same reasoning ADR-0012 recorded for adding `job_posting` as its
own domain distinct from the pre-existing `job`/`jobs` domain (ADR-0009): the chat session
is a **distinct entity** (a conversation, with its own lifecycle) from the job posting it
eventually produces, and conflating them would mean either a `job_posting.*` event firing
for a row that doesn't exist yet, or retrofitting `job_posting.*` payloads to carry
chat-session fields they were never versioned for (invariant #8).

Events (all v1, ids/enums only — **no draft field values in any payload**, matching the
confirmed convention `job_posting.*`/`ChatMessageSentPayload` already follow — carry only
ids, enums, booleans, and changed-field **keys**, never free text):

- `job_posting_chat.session_started { session_id, payer_id }`
- `job_posting_chat.message_sent { session_id, payer_id, message_id, message_type }`
- `job_posting_chat.draft_ready { session_id, payer_id }`

**The publish step does not get a new event.** It reuses the existing `job_posting.created`
event, emitted by the existing `createForPayer` call — no new writer, no payload change.

### 7. Build order and team split

Backend first, in this order, each step **freezing** what the next depends on:

1. **system-architect** — this ADR (freezes the schema shape, module boundaries, contracts,
   endpoint list, and event domain before any code).
2. **database-architect** — migration 0050 (the three tables in §Decision 1).
3. **ai-engineer** — the `apps/ai-service/app/job_posting_chat/` module + the new
   `packages/ai-contracts` / `contracts.py` contracts (§Decision 2/4).
4. **backend-engineer** — the `apps/api/src/payer-portal/job-posting-chat/` NestJS module
   (§Decision 5) + the `job_posting_chat` event domain (§Decision 6).

Steps 2–4 together **freeze the 5-endpoint API contract** in §Decision 5. Once frozen,
**`apps/payer-web`** (frontend-engineer) and **the payer-app Flutter client**
(mobile-engineer) are built **independently and in parallel** against that frozen contract —
neither depends on the other, both depend only on the backend. A joint security review and
a cross-device end-to-end test (start on one client, resume on the other) happen after both
land.

### 8. Explicitly out of scope for this ADR/slice

Each of the following is a separate, future, explicitly-decided ADR — none is started,
assumed, or pre-wired by this slice:

- **Candidate search** over job postings or applicants.
- **Bulk job posting** (batch/CSV creation).
- **Revenue dashboard / hire-commission tracking** — blocked on an undefined "views" concept;
  no view-counter exists in the schema today.
- **QR codes** for job-posting distribution.
- **Real Razorpay payments** — explicit CLAUDE.md §7 escalation requiring owner-provided
  staging keys; this slice touches no payment surface (publish is free; pricing/boosts are
  the existing, unchanged `posting-plans` machinery).

---

## Invariants upheld (CLAUDE.md §2)

- **#1 Event-first.** Every session-lifecycle write (`session_started`, `message_sent`,
  `draft_ready`) emits a `createEvent`-built, registry-validated event; the publish write
  reuses the already-event-emitting `createForPayer`. No important state change is silent.
- **#2 No raw PII leaves its boundary.** Event payloads are ids/enums/booleans/message-type
  only — never `body_text`, never the draft's free-text fields, never the payer's org name.
  The org name stays server-side (`payers.orgNameEnc`, decrypted only where already
  authorized) and is interpolated post-hoc, never sent to the LLM or stored in
  `conversation_state`.
- **#3 Pseudonymization runs before every LLM call and fails closed.** Both new AI-service
  routes sit behind the same `pseudonymize()` fail-closed gate as `/profiling/respond` — no
  new LLM path bypasses it, regardless of the principal being a payer, not a worker.
- **#4 LLMs assist; they never decide.** The interview engine is **deterministic** (topic
  bank + priority ordering + ask/clarify bounds, mirroring the worker profiling engine's
  stateless design) — the LLM's role is to rephrase questions and extract structured fields
  from free text, not to decide topic order, draft completeness, or publish readiness.
- **#6 DPDP consent gate — correctly scoped, not applicable here.** Invariant #6 gates
  processing of a **worker** before `consent.accepted`. This slice has no worker subject;
  the payer-facing chat rides `PayerAuthGuard` only, by design, not as an exception.
- **#7 Typed contracts at every boundary.** `JobPostingChatState` /
  `JobPostingChatTurnInput`/`Output` / `JobPostingDraft` are defined once in
  `packages/ai-contracts` and mirrored into `apps/ai-service/app/contracts.py`, per the
  existing enforced-parity convention.
- **#8 Backward compatibility.** Every table, contract, and event in this ADR is new and
  additive. No shipped table (`chat_sessions`, `chat_messages`, `job_postings`), column, FK,
  event payload, or contract is altered. `vacancy_band` reuses the existing banded enum
  rather than reopening ADR-0012's integer-vs-band decision.

---

## Consequences

- **Positive:** the payer/agency posting flow gets the same chat-first pattern that already
  works for worker profiling, without touching the worker-facing tables, the worker AI
  engine, or the existing job-posting creation path — the publish step is pure reuse of an
  already-shipped, already-event-emitting service method. Cross-device resume falls out of
  the existing `PayerAuthGuard` session model for free — no new device/session-linking
  mechanism was needed. The event domain split (`job_posting_chat` vs `job_posting`) avoids
  a future payload-versioning bind, matching the ADR-0012 precedent.
- **Negative / risk:** three new tables and a new AI-service module are a real amount of
  net-new surface for what is, functionally, an alternate input method for an existing
  form — accepted because the alternative (parameterizing the worker profiling engine, or
  overloading the worker chat tables) would touch shipped, load-bearing code. The
  `payer_form_drafts` table ships with **no consumer** in this slice; if no future
  workstream claims it within a reasonable window, it should be reconsidered rather than
  left as speculative surface.
- **Rollback story:** additive-only. Rollback = drop the three new tables child-first
  (`payer_job_posting_chat_messages` → `payer_job_posting_chat_sessions` →
  `payer_form_drafts`), remove the `job_posting_chat` event domain and its three v1 events,
  remove the `apps/api/src/payer-portal/job-posting-chat/` module and the two new
  `AiService` methods, and remove the `apps/ai-service/app/job_posting_chat/` module. No
  existing table, column, contract, or event payload is touched, so rollback does not
  affect the worker profiling chat, the worker chat tables, or the existing manual
  job-posting form/publish path.
- **Version strategy:** all three new events ship as v1. Any later field change is a new
  version, never an in-place mutation (invariant #8).

---

## Amendment 1 (2026-09-04) — `payer_form_drafts` is CLAIMED by phase P8

**Status:** Accepted — owner ruling (Prakash), 2026-09-04.

This ADR shipped `payer_form_drafts` with **no consumer**, as deliberate forward scaffolding,
and §Consequences asked for exactly this decision: *"if no future workstream claims it within
a reasonable window, it should be reconsidered rather than left as speculative surface"*
(with `packages/db/src/schema/payer.ts:770-771` adding that a claim comes "via an ADR").

**The workstream that claims it is P8** (`docs/agent/phases/P8_BUILD.md`) — job-posting drafts
and checkpoints. The alternative considered and rejected was a third draft store built beside
this one: the repository would then hold `payer_job_posting_chat_sessions.draft` (in use),
`payer_form_drafts` (unused), and a new `job_posting_drafts` — three answers to one question.

### What changes about the table

Two schema changes, both required by the claim and neither optional:

1. **A `version` column.** The table as shipped has none, so it is last-write-wins. That is
   the precise defect P8 exists to close — `job-posting-chat.repository.ts:120-125` already
   names optimistic concurrency as the unbuilt follow-up.
2. **`UNIQUE(payer_id, form_type)` is relaxed.** One row per payer per form cannot hold a
   new-posting draft and a reopened edit of a published posting at the same time, and P8
   needs both to coexist. The replacement (a widened key, or a partial index over the live
   status) is P8's to choose and to justify in its plan.

The remaining P8 fields — `current_step_id`, `completed_step_ids`, `payload`,
`schema_version`, `source_posting_id`, `status`, `last_client`, `expires_at` — and the
append-only checkpoint child table are additive and carry no amendment burden here.

### What this supersedes in the text above

The two "no consumer" statements — §Decision's `payer_form_drafts` bullet and §Consequences'
reconsider-it note — are **historical from this date**. The table has a named consumer. Its
`state` jsonb keeps the same posture: a form snapshot keyed to the opaque `payer_id`, with
the no-free-text-into-events rule unchanged.

**What does NOT change.** The job-posting chat keeps writing its own
`payer_job_posting_chat_sessions.draft` column until P8 migrates it; this amendment claims
the table, it does not move the chat. The five shipped chat routes are untouched.

---

## Related

- ADR-0019 (`docs/decisions/0019-self-serve-payer-portal.md`) — `payers` account,
  `PayerAuthGuard`, `assertPayerOwns` (the account and guard reused)
- ADR-0012 (`docs/decisions/0012-ops-job-postings-banded-stored-only.md`) — `job_postings`,
  `vacancy_band`, and the "new additive event domain for a distinct entity" precedent
- ADR-0022 (`docs/decisions/0022-agency-supply-portal.md`) — the "sibling table, not a
  shipped-NOT-NULL-FK retrofit" precedent (`agency_invites` vs `invites`)
- ADR-0005 (`docs/decisions/0005-metadata-driven-multi-profile-profiling.md`) — the worker
  profiling engine pattern this slice's AI-service module mirrors
- `apps/ai-service/app/profiling/` — the sibling module pattern (question bank, interview
  engine, prompts)
- `apps/api/src/chat/chat.controller.ts` — the #349 no-oracle transcript-hydration pattern
- `apps/api/src/job-postings/job-postings.dto.ts` (`PayerCreateJobPostingSchema`),
  `apps/api/src/job-postings/job-postings.service.ts` (`createForPayer`) — the unchanged
  publish target
- `packages/validators` (`bandForCount`) — the vacancy-banding validator reused, not reinvented
- `packages/ai-contracts/src/index.ts` / `apps/ai-service/app/contracts.py` — the existing
  `ConversationState` / `ProfilingTurnInput`/`Output` / `WorkerProfileDraft` contracts mirrored
- CLAUDE.md §2 invariants 1, 2, 3, 4, 6, 7, 8; §4 module convention; §7 escalation; §8
  deferred scope

*This ADR records the approved architecture for the AI job-posting chat + cross-device
drafts slice (2026-07-27). It is the gate; implementation proceeds per the build order in
§Decision 7.*

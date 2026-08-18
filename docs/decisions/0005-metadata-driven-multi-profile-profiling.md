# ADR-0005: Metadata-driven multi-profile profiling — capture-vs-match architecture

- **Status:** Proposed (revised after adversarial review — awaiting owner sign-off)
- **Date:** 2026-06-11
- **Supersedes/relates:** replaces the hardcoded role/question config in
  `apps/ai-service/app/profiling/question_bank.py` (and its duplicated TS mock) →
  pays down the **data half of TD17**; builds on **ADR-0002** (async extraction) and the
  existing `worker_profiles` canonical record; respects **ADR-0003** (raw-conversation
  storage boundary) and **ADR-0004** (PII only in encrypted `workers`); makes **TD21**
  (encrypt `full_name`) a precondition; sets up the day-one data substrate for the Reach
  Engine (**TD8**) per *"BadaBhai — The Matching Algorithm, in Plain English"*.

## Context

Phase 1 profiles a single role family (`cnc_vmc`, 7 roles), with interview questions
hardcoded as Python dataclasses in `question_bank.py` and **duplicated** in the TS mock
(**TD17**). The product must scale to **100+ trades, each with its own questions** —
which cannot mean 100 code edits + deploys.

Two forces pull opposite ways:

- **Authoring + capture** wants *flexibility* — add a trade and its questions as data.
- **Matching** (the locked Reach Engine) wants *typed, indexed, queryable* fields. Per
  the behaviour spec, relevance = trade + travel-distance + experience + pay +
  availability + activity; it **sorts but never blocks**, **works on partial profiles**,
  and the **behavioural record is captured from day one** (ranking/learning is Phase 2).

A pure EAV (entity-attribute-value) store is great for the first force and poor for the
second. The decision is how to get flexible authoring **without** making EAV the match
substrate — and **without** overstating today's schema (see the review note below).

## Decision

A **capture-vs-match (CQRS) split** in three layers. Authoring/capture is
metadata-driven; matching reads a typed projection.

### Layer 1 — Definition (admin-curated, versioned, cached)

```
profiles                 profile_versions            questions
--------                 ----------------            ---------
id                       id                          id
slug        (stable)     profile_id                  question_key   (stable)
name                     version_no                  answer_type    text|number|date|
status                   status  draft|published|                   single_select|multi_select
active_version_id                archived            validation     (required, min, max,
                         published_at                               date-range — jsonb)
                                                     extraction_topic ("experience.total_years")
profile_questions        question_options
-----------------        ----------------
id                       id
profile_version_id       question_id
question_id              option_key
display_order            label        (English)
is_required              display_order
```

- **Answer types** `text | number | date | single_select | multi_select` reconcile owner
  #1 (text/number/date) with #2 (fixed options): the select types resolve to
  `question_options`, admin-curated and fixed.
- **Versioning is questionnaire-level** (owner #4). Keep **≤3 published versions** per
  profile; prune the oldest **only if it has zero answers**, else **archive** (never
  hard-delete a version answers reference).
- **The cache is a first-class requirement, not a footnote.** The AI service has **no DB
  or cache client today** (`question_bank.py` is in-memory) — this ADR adds a DB
  dependency to the per-turn interview path, so it must be cached: key =
  `profile_version_id`, value = the fully-assembled questionnaire (questions + options +
  ordering), populated by **one bounded read per active version**, TTL +
  **invalidate-on-publish**. Specify cold-start (a single assembling read, never
  per-question → avoids an N+1) and the new per-turn failure mode. **The offline TS mock
  must still work without the DB** (it ships a seeded snapshot).
- **TD17 is only half-closed by this.** The tables remove the **data** duplication.
  TD17 is *also* a **readiness-semantics** duplication: the Python engine derives
  `answered_topics` from message signals (`signals.py`) while the TS mock marks one topic
  per turn. Sharing tables does **not** unify that rule, and two runtimes (FastAPI +
  Nest) reading the same Postgres needs a shared/generated contract to interpret
  `answer_type`/`validation`/`is_required` identically. → *Pays down the data half;
  readiness-rule unification is an explicit follow-up.*

### Layer 2 — Capture (PII-minimized, worker-linked, typed)

```
worker_answers
--------------
id
worker_id
profile_version_id        (pins the version answered)
question_id
answer_text | answer_number | answer_date | answer_option_id   (exactly one, CHECK-enforced)
source                    chat | form | import
answered_at
```

- **Typed columns**, with a `CHECK` that **exactly one** of
  `answer_text/number/date/option_id` is non-null — so a question can't be written in two
  shapes.
- **PII-minimized, NOT "PII-free by construction."** Structured columns
  (`answer_number/date/option_id`) and the dedicated identity preamble are clean, but
  `answer_text` is free input and workers **do** type names/phones/employers into chat
  ("Mera naam Rahul, 9876543210, ABC Industries"). Therefore:
  - For `source=chat`, `answer_text` is **run through the existing pseudonymization
    gateway** (`apps/ai-service`) — or PII-rejected — **before persist**; prefer storing
    the **extracted structured value** and keeping raw free-text only where ADR-0003
    already governs raw chat (under TD20 RLS).
  - **Events/analytics read typed columns / option_ids only — never `answer_text`.**
  - Add a **no-PII-in-`answer_text`** capture-path test, mirroring the e2e
    no-PII-in-`conversation_state` assertion (TD19).
- **Idempotent writes, split by cardinality** (the two-partial-index sketch was
  insufficient):
  - **Cardinality-1** (`text/number/date/single_select`): `UNIQUE (worker_id,
    question_id)` + `ON CONFLICT (worker_id, question_id) DO UPDATE` → a re-answer or a
    changed single-select **replaces in place** (no orphan rows).
  - **Multi-select**: `UNIQUE (worker_id, question_id, answer_option_id)` → one row per
    chosen option, `ON CONFLICT … DO NOTHING`.
  - Which index applies is driven by `questions.answer_type` (known at write time).
- **Index `worker_answers(profile_version_id)`** (composite `(profile_version_id,
  worker_id)`) — the prune-eligibility `EXISTS` check and the per-version
  projection/backfill read by version, not by `worker_id`.
- **PII preamble → `workers` (owner #6), with TD21 as a hard precondition.** Name/contact
  are a fixed preamble written to the **encrypted `workers`** table — but `full_name` is
  **plaintext today (TD21, Open)**. **No name-capture write site lands until `full_name`
  is encrypted at rest** (`encryptPii` + optional `name_hash`). The raw name must never
  transit events/ai_jobs/logs or `worker_answers` on its way to `workers`.

### Layer 3 — Match (`worker_profiles`, made genuinely typed + extended)

**Honest correction (review):** `worker_profiles` is *not* fully "typed + indexed" today.
Only `canonical_trade_id`/`canonical_role_id` are scalar columns and the 768-dim HNSW
embedding is indexed; `skills`/`machines`/`experience`/`salary_expectation`/
`location_preference`/`availability` are **loose JSONB** — as un-filterable as EAV. So the
CQRS premise is made *true*, not assumed, by this migration:

- **Add the Reach filter fields as real typed columns**: `experience_years`,
  `salary_min` / `salary_max`, `availability_status` (enum), alongside the geo + the
  embedding. These are what the engine filters/sorts on; the JSONB stays for display.
- **Geo = CITY CENTROID, not a worker-precise point (DPDP minimization).** Store
  `geo_lat` / `geo_lng` **derived from the worker's already-consented city** +
  `travel_radius_km`. The consent taxonomy (`CONSENT_PURPOSES`) has **no geolocation
  purpose**; centroid-from-city stays within the existing `profiling` basis. *If* finer
  precision is ever needed, it requires a new `location_matching` consent purpose and is a
  DPDP launch gate (risks register R4). Geo columns join the **TD20 RLS** scope. (The
  job-side location + the actual haversine/PostGIS distance computation are **Phase-2
  Reach Engine** concerns; consider `geography` vs raw doubles then.)
- **Recency without a lossy denormalization.** Drop the standalone `last_active_at`;
  "are they active" is computed at match time from **existing** signals
  (`chat_sessions.last_message_at` + the `action.recorded` engagement stream). If a
  denormalized field is later wanted, it must name its writer/refresh event.
- **Projection = a debounced background job, not per-answer.** `worker_profiles` has **no
  embedding writer today** — recompute is net-new. A managed Vertex embedding call **per
  answer** would be N external calls per worker across a turn-by-turn interview. So the
  projection (answers → typed columns + embedding) runs as a **coalesced BullMQ job**
  keyed per `(worker_id, profile_version_id)`, fired **on extraction-readiness or a short
  debounce after the last answer**, and **skips the embedding if the projected fields
  didn't change** (hash them). Consistent with ADR-0002 and the future-improvements
  embedding-queue note.
- **Projection idempotency — reconcile with the existing model.** `worker_profiles` today
  has one anchor (`worker_profiles_ai_job_id_uq`) and is "one current profile per worker"
  (Phase-1). The projection **upserts the worker's single current profile keyed by
  `worker_id`** (latest version wins), recording `profile_version_id` + `ai_job_id` as
  provenance — this is **distinct from** TD14's `ai_job_id` creation key, and the two
  write paths must be reconciled so exactly one canonical row per worker is maintained
  (today the auto-trigger's `latestProfile` guard already enforces that). Multi-trade
  profiles per worker would be a deliberate future change (a `(worker_id, profile_id)`
  key), not assumed here.
- **Sort-never-block is an invariant, stated explicitly:** `is_required` /
  extraction-readiness governs the **interview and projection only**. The Reach Engine
  **must treat every projected match field as optional** — it may sort on a field's
  presence but **must never filter a worker out for a missing field**.

### Conversational-first (recommended resolution of open decision #1)

Questions are a **topic catalog the AI converses around**, not a rigid form.
`extraction_topic` maps each question to a match signal; `is_required` drives readiness
(today's `core`). A form is an alternate **renderer** over the same definitions. Per §3,
when a high-value job needs one missing detail, the chat asks exactly that one question.

### Behavioural capture — day-one vs Phase-2 (corrected)

The locked algorithm needs the behavioural record **from day one** — but **most of the
events I first listed are Phase-2 employer surfaces** and can't be emitted in Phase 1:

- **Day-one (capturable now, on the existing spine — no new event names):** worker-side
  behaviour already flows through `chat.*`, the `profile.*` lifecycle, and the **generic
  `action.recorded` recorder** (controlled `ACTION_TYPES`, purpose-built so "a new
  behaviour is a data change, not a schema rebuild" — the same philosophy this ADR uses
  for questions). Worker engagement signals (app-opened, profile-reviewed, …) extend
  `ACTION_TYPES`; LEARN reads these. **This is the day-one behavioural substrate.**
- **Phase-2 (ships with the employer surfaces, NOT registered now):** `feed.shown`,
  `application.submitted/replied`, `worker.unlocked/contacted` require surfaces that don't
  exist in Phase 1 (employer search, feed, unlock, contact — locked to Phase 2 with
  payments), **and** new closed-enum vocabulary: `EVENT_DOMAINS` (`feed`, `application`),
  `SUBJECT_TYPES` (`job`, `application`), and activating the `payer`/`agent` actor types.
  Registering them now would cross the phase boundary (`payloads.ts` explicitly defers the
  match-feedback loop). They are emitted **when their producing surfaces ship.**

## Consequences

- **Add a trade = data inserts** — no migration/deploy. Scales to 100+/1000+.
- **Matching is genuinely typed** after this migration (new scalar columns + geo +
  embedding), insulated from `worker_answers` growth (read only per-worker / per-version).
- **Additive schema:** 5 definition tables + `worker_answers` (+ CHECK, cardinality
  indexes, version index) + new `worker_profiles` columns (`experience_years`,
  `salary_min/max`, `availability_status`, `geo_lat/lng`, `travel_radius_km`) — all
  backward-compatible.
- **New surfaces to test:** the debounced projection job (idempotent, null-tolerant,
  change-detecting), the definition cache (invalidate-on-publish, offline-safe), geocoding,
  and the no-PII-in-`answer_text` guard.
- **`worker_answers` is PII-minimized** (gateway on chat input) and read via typed columns
  only — but the spine still needs **RLS (TD20)** before any client→DB path.
- **Cost:** AI service gains a DB dependency on the per-turn path (cache-mitigated) and a
  background embedding job; both follow existing async discipline.

## Open / deferred (owner sign-off)

1. **Conversational-first vs. form** — assumed conversational (topic catalog).
2. **`worker_answers` → `worker_profiles` projection** — assumed the hybrid; needs the
   `worker_id`-keyed upsert reconciliation with the `ai_job_id` model (Layer 3).
3. **`single_select` / `multi_select` answer types** — added to reconcile #1/#2/#3.
4. **Reach Engine** ranking, pacing, hot-tag, contact-cap, agency attribution, **and the
   job/employer side of distance** — Phase 2 (TD8), out of scope. Only the worker-side
   data substrate is set up here.
5. **i18n** — English in DB + a curated frontend catalog keyed by `question_key` (owner
   #5); no runtime auto-translation.
6. **No grouping** (owner #7) — flat `profiles`; a nullable `category` can be added later.

## Follow-ups (tracked)

- **Pays down the data half of TD17**; **opens** a readiness-semantics-unification item
  (port `signals.py` detection or have both runtimes derive readiness from `is_required`
  via a shared, tested contract).
- **Makes TD21 a blocking precondition** of the identity preamble.
- **Opens (to be logged on acceptance):** geocoding-to-centroid + the new typed
  `worker_profiles` columns; the **debounced projection/embedding BullMQ job**; the
  no-PII-in-`answer_text` pseudonymization guard; geo columns into the **TD20** RLS scope;
  the Phase-2 behavioural-event family (with its `EVENT_DOMAINS`/`SUBJECT_TYPES`/actor
  extensions) deferred to the employer surfaces.
- **Seed Layer 1 from the existing `cnc_vmc` bank** as the first content migration (7
  roles → profiles; topics → questions; `core` → `is_required`), so behaviour is identical
  on day one and the 100+ trades are added as pure data.

*This ADR defines architecture and schema shape for sign-off. No application code is
written until it is Accepted.*

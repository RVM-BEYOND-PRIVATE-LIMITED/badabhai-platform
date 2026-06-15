# ADR-0009: Job entity + lifecycle (Phase-2 Wave A)

- **Status:** Accepted — built 2026-06-15 under explicit authorization that the
  [schema freeze](../registers/team-decisions.md) is cleared for the Phase-2 Wave-A
  start (Divyanshu). The Phase-2 surfaces listed under *Out of scope* remain deferred.
- **Date:** 2026-06-15
- **Supersedes/relates:** builds on **ADR-0006** (the deterministic RANK core +
  the `feed.*`/`application.*` contracts + the `job` subject type, all defined "for
  when the Phase-2 job entity ships" — this is that entity). Adds to the governed
  event contract (`@badabhai/event-schema`). Honours the dead decision against a
  structured **Employer entity** (faceless rails — payers, not employers).

## Context

ADR-0006 built the demand-side `JobSpec` type and the worker-side behavioural events
but explicitly deferred "the job/employer entity" to Phase 2. Wave A needs the entity
itself: a **Job** is the `posting_fee` billable object — a work opportunity a **payer**
(company or agency) posts. The platform is **faceless rails**: a job is referenced by an
opaque `payer_id`; there is no structured Employer entity and no payer identity in the
event spine. The named Wave-A behaviours are: a vacancy band, a stamped applicant quota,
applicants-received tracking, **pause-at-quota**, boost fields, and lifecycle events.

## Decision

**1. New `jobs` table (`@badabhai/db`, migration `0012`).** Columns map cleanly to the
reach-engine `JobSpec` (role slugs, city-centroid location, travel/experience/pay bands,
`needed_by`) plus lifecycle state. Follows the schema conventions (uuid PK, timestamptz,
status-like columns as `text` + inline `$type<…>()`). **No raw PII:** `payer_id` is an
opaque UUID with **no FK** (no `payers` table); the free-text `title` is stored on the
row but never enters an event or a log. Light CHECKs guard the counts.

**2. Lifecycle state machine** (enforced in `JobsService`; an invalid transition is a
`409`): `draft → active ⇄ paused → closed`. At **activation** the `applicant_quota` is
**stamped** (`vacancy_count × WAVE1_APPLICANT_MULTIPLIER` = 3 by default, override
allowed) and the free-intro window + posting-fee scalar are stamped. When
`applicants_received_count` reaches the stamped quota the job **auto-pauses**
(`pause_reason = "quota_reached"`). Pricing/band **config stays out of the schema** by
design — only the *stamped results* live on the row.

**3. Boost = tier enum + window**, stored now (`boost_tier none|standard|premium` +
`boosted_at` + `boost_expires_at`); the *ranking* use of boost stays deferred to the
Reach Engine (boost never overrides the relevance floor — ADR-0006).

**4. New `job` event domain + 6 lifecycle events** (`@badabhai/event-schema`, all v1,
PII-free — opaque `job_id`/`payer_id` + slugs/counts/enums only): `job.created`,
`job.activated`, `job.paused`, `job.resumed`, `job.closed`, `job.boosted`. Manual pause
and pause-at-quota share **one `job.paused` event with a `reason` enum**
(`manual | quota_reached`), following the `action.recorded` "taxonomy-as-data" precedent.
Once-only transitions (created/activated/closed) carry an `idempotencyKey`; the
legitimately-repeatable ones (paused/resumed/boosted) are unkeyed.

**5. API module** (`apps/api/src/jobs`, thin controller → service → repository + Zod DTO)
exposes the full lifecycle (create, activate, pause, resume, close, record-applicant,
boost) + ops read (list/get). All routes are behind **`InternalServiceGuard`** (the
shared-secret seam, fail-closed) because there is **no payer auth yet** — the same
interim posture as the resume PII routes.

## Explicitly OUT of scope (deferred)

Payments / a `payers` table / payer auth; the worker **feed surface** and real
`application.submitted` emission (the `POST /jobs/:id/applicants` endpoint is an
**interim ops/test seam** to exercise pause-at-quota until the feed lands); PACE
supply-widening + ops alerts; boost *ranking*; vacancy-band/price **config tables**
(CBA-pending); per-payer authz; a `jobs` RLS policy.

## Consequences / follow-ups

- **Per-payer authz is a launch gate** — today every internal caller can read/mutate
  every payer's jobs (shared token only). Tracked as **[R15](../registers/risks-register.md)**
  (ties R1/TD4); must land before any payer-facing job surface.
- **Applicant increment is read-then-write** (lost-update / quota-overshoot under
  concurrency) — acceptable for the interim ops seam; replace with an atomic SQL
  increment when the worker feed drives it. Tracked as **[TD31](../registers/tech-debt-register.md)**.
- **`jobs` joins the RLS backlog** — added to [rls-plan.md](../../infra/supabase/rls-plan.md);
  inherits the service-role-only posture until then. Tracked under **TD31**.
- **Security gate: PASS-WITH-NOTES** (2026-06-15) — no must-fix; privacy invariant holds
  (no title/payer identity in any event or log), event-first coverage complete, migration
  additive + reversible, guard fails closed.

## Alternatives considered

- **A structured Employer/Payer entity now** — rejected (dead decision; faceless rails).
  `payer_id` is opaque; a payer record (with any identity) is a later, separate concern.
- **Config tables for vacancy bands / prices** — rejected for Wave A (config stays out of
  schema; we stamp the resolved quota/fee on the job row).
- **Two pause events** (`job.paused` + `job.paused_at_quota`) — rejected in favour of one
  event + a `reason` enum (taxonomy-as-data; fewer registry entries, still ops-alertable).

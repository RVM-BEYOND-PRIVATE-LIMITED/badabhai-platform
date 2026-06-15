# ADR-0009: Alpha swipe-to-apply on seeded jobs (activate the Reach behavioural events without the Phase-2 feed)

- **Status:** Accepted (human sign-off 2026-06-15, Prakash). Crosses the Phase-1/2 boundary deliberately and narrowly; all Phase-2 surfaces named in ADR-0006 remain OUT (see §6). Open questions resolved at sign-off: **OQ-1 → a reusable `ConsentGuard`** applied to all three worker routes; **R-A → bounded per-impression `feed.shown`** (default 20, max 50; no dedupe until volume warrants).
- **Date:** 2026-06-15
- **Phase:** Alpha (a scoped early activation that sits beside Phase 1, ahead of Phase 2).
- **Relates:** activates the `feed.shown` / `application.submitted` / `application.skipped`
  contracts defined in **ADR-0006** (Reach foundation, "contract ahead of producer"; itself
  building on **ADR-0005**). Honours all CLAUDE.md §2 invariants. Decision artifact only —
  **no app code, no migration** ships with this ADR; implementation is handed to the engineer
  agents as Stream A (DB) → Stream B (API) → Stream C (clients).

---

## Context

ADR-0006 ratified the deterministic RANK core **and** defined three PII-free behavioural
events (`feed.shown`, `application.submitted`, `application.skipped`) as a *contract ahead of
producer* — "defined now; emitted when the Phase-2 feed surface ships." The producers of those
events — the job/employer entity and the worker feed — were listed as Phase-2 follow-ups.

We now want an **alpha** swipe-to-apply surface: a worker can see a small set of jobs and
apply or skip. The value is twofold: (1) it lets us watch real apply/skip behaviour and start
accumulating the day-one behavioural history ADR-0005/0006 always wanted "captured from day
one"; (2) it de-risks the eventual feed by exercising the event contracts end-to-end with a
real producer.

The trap is scope creep: a "feed" naturally invites employer posting, unlock/contact,
payments, and Reach ranking — all explicitly deferred. This ADR decides the **smallest
surface** that emits the existing events honestly, and draws a hard line around everything
Phase-2.

**Verified facts this decision rests on (confirmed against the repo, 2026-06-15):**

- The three events exist in `packages/event-schema/src/payloads.ts` (~L437–463) and are
  registered v1 in `registry.ts` (~L123–133), domains `feed` / `application`, subject type
  `job`. They are PII-free: `worker_id` + opaque `job_id` + enums/ranking signals only.
- **Every ranking/signal field on these payloads has a safe default**: `feed.shown` →
  `score` default `0`, `hot` default `false` (only `rank` is required, an int ≥ 1);
  `application.submitted` → `rank` default `null`, `source_surface` default `"feed"`;
  `application.skipped` → `reason` default `"other"`. **KEY IMPLICATION (confirmed): alpha can
  emit all three with no payload change at all** — pass the seeded display order as `rank`,
  let `score`/`hot` take their defaults (0 / false), use `source_surface: "feed"` and an
  enum `reason`. **No payload version bump is required.** This is correct *because* alpha does
  not rank: `score = 0` is the honest value when no Reach Engine ran (LLMs/heuristics never
  score here — the AI-never-ranks pillar is untouched).
- DB today has 14 `pgTable`s (`workers`, `worker_consents`, `worker_profiles`,
  `chat_sessions`, `voice_notes`, `chat_messages`, `generated_resumes`, `events`, `ai_jobs`,
  `audit_logs`, `profiles`, `questions`, `profile_questions`, `worker_answers`). **There is no
  `jobs` table and no `applications` table.** (CLAUDE.md §4 still says "10 tables" — stale; see
  §7 doc-fix.) The "PII lives only in `workers`" invariant holds and this ADR keeps it.
- `apps/api` follows `controller → service → repository + dto(zod) + module`. There is no
  feed/jobs/applications module today. `apps/api/src/resume` is the reference for guards +
  `events.emit({ actor, subject, payload, correlationId, requestId })`.
- `WorkerAuthGuard` + `@CurrentWorker()` (`apps/api/src/auth/worker-auth.guard.ts`) gate
  worker-scoped routes (used by resume download); `InternalServiceGuard`
  (`apps/api/src/common/guards/internal-service.guard.ts`) gates ops/read routes.
- Consent is captured as `consent.accepted` in `consent.service.ts`, but there is **no
  reusable "require active consent before this action" primitive** in the API today — chat /
  profiling enforce the gate at their own boundaries. Apply/skip is a worker action on the
  worker's own data, so it **must** sit behind the consent gate (mirroring profiling); the
  absence of a shared guard is a follow-up, not a blocker (see §6 risks).

---

## Decision

Build the **smallest honest producer** of the existing events: a lean seeded `jobs` table, an
`applications` table, three worker endpoints (feed / apply / skip) and two ops read endpoints.
No ranking, no employer console, no contact/unlock, no payments.

### 1. What workers apply to — a lean seeded `jobs` table (not a static fixture)

**Decision: a lean `jobs` table seeded via `packages/db/src/seed*.ts`.** Rejected: a static
in-repo JSON/TS fixture served from the API.

**Why the table wins despite the fixture being "leaner" to write:**
- **Referential integrity + ops listing.** Requirement #1 demands "ops can list applicants per
  job." `applications.job_id` should be a real FK to a real row so the ops query is a plain
  join and a typo'd `job_id` can't create orphan applications. A fixture gives no FK and forces
  the applicant-per-job listing to reconcile against an in-memory map.
- **`subject_type: "job"` honesty.** The events carry `subject.subject_id = job_id`; that id
  should resolve to a persisted entity for the audit spine to mean anything.
- **It is still lean.** The table holds only coarse, non-PII fields (below) and is populated by
  a deterministic, committed seed — no employer console, no write API. Reseeding is idempotent
  (stable UUIDs in the seed). This is the leaner option *that still satisfies the ops
  requirement*, which is the bar set in #1.

The seed is the alpha's "job source." Stable `job_id` UUIDs live in the seed file so the same
jobs exist across environments and reseeds.

### 2. Minimal data model (backward-compatible, PII-free)

Two new tables, additive only. Conventions match `schema.ts` (uuid PKs `gen_random_uuid()`,
`timestamptz`, status as `text` with `$type<...>()`, idempotent seed).

**`jobs` — seeded, coarse, NO employer PII**

| column        | type                          | notes |
| ------------- | ----------------------------- | ----- |
| `id`          | uuid PK (`gen_random_uuid()`) | the opaque `job_id` carried in events |
| `trade_key`   | text (`$type<TradeKey>()`)    | one of the 15 alpha trades (taxonomy); FK-by-convention to the trade taxonomy, not a PII employer |
| `title`       | text                          | generic role title, e.g. "CNC Operator — Night Shift". **No employer name.** |
| `city`        | text                          | COARSE location only (city). Non-PII. |
| `area`        | text (nullable)               | COARSE area/locality bucket, NOT an address. Nullable. |
| `status`      | text (`$type<JobStatus>()`)   | `'open' \| 'closed'`; default `'open'`. Lets a seed job be retired without delete. |
| `created_at`  | timestamptz default `now()`   | |
| `updated_at`  | timestamptz default `now()`   | |

**Explicitly absent from `jobs` (the privacy line): no `employer_name`, no `employer_id`, no
contact, no phone, no exact address/geo, no pay/salary field.** `title` is a generic role
string authored in the seed, never an employer identity. If pay ever appears it is a Phase-2
decision (it rides with unlock/economics) — keep it out now so the "never employer name, pay,
or worker contact" line from the event comment holds at the data layer too.

> *Note on pay:* dropping pay also means `application.skipped.reason = "low_pay"` is an enum the
> worker can select expressively even though the alpha shows no pay number. That is fine — the
> reason is the worker's stated motive, not a derived fact, and stays PII-free.

**`applications` — the apply/skip record, PII-free**

| column           | type                                   | notes |
| ---------------- | -------------------------------------- | ----- |
| `id`             | uuid PK (`gen_random_uuid()`)          | |
| `job_id`         | uuid NOT NULL → FK `jobs.id`           | |
| `worker_id`      | uuid NOT NULL → FK `workers.id`        | the only join back to identity; identity stays in `workers` |
| `action`         | text (`$type<'applied' \| 'skipped'>()`) | NOT NULL |
| `reason`         | text (`$type<SkipReason>()`) nullable  | populated **only** when `action = 'skipped'`; one of the `application.skipped` enum; `null` for `applied`. Enforce with a CHECK (`reason IS NULL OR action = 'skipped'`). |
| `source_surface` | text (`$type<SourceSurface>()`)        | default `'feed'`; mirrors the event enum |
| `rank`           | integer nullable                       | the seed display position the action was taken from; nullable |
| `created_at`     | timestamptz default `now()`            | |
| `updated_at`     | timestamptz default `now()`            | bumped on last-write-wins re-decision |

**Idempotency — UNIQUE on `(worker_id, job_id)`, last-write-wins.**

- **Unique key:** `uniqueIndex` on `(worker_id, job_id)`. A worker has at most one decision row
  per job, so a double-tap cannot create duplicate applications. This is the natural key the ops
  "applicants per job" / "decisions per worker" queries read.
- **Last-write-wins (not first-write-wins).** Justification: a worker who skipped then changes
  their mind and applies (or vice-versa) should land on their *latest* intent — the row's
  `action`/`reason`/`updated_at` reflect the most recent decision. The write is an **upsert**
  (`ON CONFLICT (worker_id, job_id) DO UPDATE`). The *audit history* of the flip is **not** lost
  — every decision still emits its own event into the `events` spine, so the sequence
  apply→skip→apply is fully reconstructable from events even though the `applications` row holds
  only the current state. (First-write-wins would silently swallow a genuine mind-change and
  make the table disagree with the latest event — rejected.)

**Confirmation (privacy):** across both tables the only identity reference is
`applications.worker_id` (FK into `workers`, where PII already lives, RLS-locked). `jobs` carries
zero PII. Everything the events touch — `job_id`, `worker_id`, `action`/`reason`/`source_surface`
enums, integer `rank` — is exactly what the v1 payloads already permit. **No new PII surface is
created.**

### 3. Event emission — no payload version bump

Each endpoint emits an **existing v1 event, unchanged**, via the standard
`EventsService.emit({ event_name, actor, subject, payload, correlationId, requestId })` path
(mirroring `resume.controller.ts`). Mapping:

| Endpoint            | Event                    | actor                         | subject                       | payload (alpha values) |
| ------------------- | ------------------------ | ----------------------------- | ----------------------------- | ---------------------- |
| `GET /feed`         | `feed.shown` (per impression) | `worker` / `worker.id`   | `job` / `job_id`              | `{ worker_id, job_id, rank: <1-based seed order>, score: 0 (default), hot: false (default) }` |
| `POST /applications/:jobId/apply` | `application.submitted` | `worker` / `worker.id` | `job` / `job_id`     | `{ worker_id, job_id, rank: <from request, nullable>, source_surface: "feed" }` |
| `POST /applications/:jobId/skip`  | `application.skipped`   | `worker` / `worker.id` | `job` / `job_id`     | `{ worker_id, job_id, reason: <enum from request, default "other"> }` |

**Explicit statement (confirmed): NO event payload needs a version bump.** Every signal field
beyond the required `worker_id`/`job_id`/(`rank` on `feed.shown`) has a safe default, and alpha's
honest values are exactly those defaults plus a deterministic seed-order `rank`. `score = 0` /
`hot = false` are *truthful* in alpha because **nothing ranked** — emitting them is not a
degraded signal, it is the correct signal for an unranked surface. When the Phase-2 Reach feed
ships and actually scores, it writes real `score`/`hot` into the *same* v1 payload; alpha rows in
the events spine remain valid and distinguishable (score 0, source still "feed"). This satisfies
CLAUDE.md §2 invariant 8 (backward compatibility) with zero schema churn.

`feed.shown` is emitted **one event per surfaced job per fetch** (one impression each). To avoid
unbounded event volume on the alpha, the feed endpoint serves a small bounded page (see §4) and
emits one `feed.shown` per item returned.

### 4. API contract (shape only — no implementation)

New module `apps/api/src/applications/` (owns apply/skip + ops reads) and a thin
`apps/api/src/feed/` read (or fold feed into the applications module — engineer's call; the
contract below is module-agnostic). Standard `controller → service → repository + dto(zod) +
module`. All worker routes are **`WorkerAuthGuard` + consent-gated**; all ops routes are
**`InternalServiceGuard`** and return PII-free projections.

**Worker — feed (consent-gated)**
```
GET /feed
  Guard: WorkerAuthGuard  + consent gate (worker must have accepted consent)
  Query (Zod): { limit?: int 1..50 = 20 }
  Behaviour: returns up to `limit` seeded jobs with status='open', deterministic order
             (e.g. created_at asc, id tiebreak). Emits one `feed.shown` per returned job,
             rank = 1-based position, score=0, hot=false.
  Response DTO (Zod field list):
    { jobs: Array<{ job_id: uuid, trade_key: string, title: string,
                    city: string, area: string|null, rank: int }> }
  (No PII; no pay; no employer.)
```

**Worker — apply (consent-gated, idempotent)**
```
POST /applications/:jobId/apply
  Guard: WorkerAuthGuard + consent gate
  Param: jobId (ParseUUIDPipe) — must resolve to a jobs row (else 404, no oracle)
  Body (Zod): { rank?: int>=1 | null = null, source_surface?: "feed"|"search"|"share"|"other" = "feed" }
  Behaviour: upsert applications (worker_id, job_id) -> action='applied', reason=null,
             last-write-wins; emits `application.submitted`.
  Idempotency: repeat apply on same (worker,job) = 200 idempotent (no duplicate row, no
             error). Re-emits the event (the spine records each tap) OR de-dupes via the
             event idempotencyKey — RECOMMEND idempotencyKey
             `application.submitted:{worker_id}:{job_id}` so a double-tap is one logical
             event. (Engineer decides; default to de-dupe to keep the spine clean.)
  Response: { ok: true, application_id: uuid, action: "applied" }
```

**Worker — skip (consent-gated, idempotent)**
```
POST /applications/:jobId/skip
  Guard: WorkerAuthGuard + consent gate
  Param: jobId (ParseUUIDPipe) -> 404 if unknown
  Body (Zod): { reason?: "not_interested"|"too_far"|"low_pay"|"wrong_trade"|"other" = "other" }
  Behaviour: upsert applications (worker_id, job_id) -> action='skipped', reason=<enum>,
             last-write-wins; emits `application.skipped`.
  Idempotency: same as apply (one row per worker/job; double-tap idempotent).
  Response: { ok: true, application_id: uuid, action: "skipped" }
```

**Ops — read (InternalServiceGuard, PII-free projections)**
```
GET /jobs/:jobId/applicants
  Guard: InternalServiceGuard
  Response (Zod): { job_id: uuid, applicants: Array<{
      worker_id: uuid, action: "applied"|"skipped", reason: string|null,
      source_surface: string, rank: int|null, created_at, updated_at }> }
  NOTE: worker_id only — NO name/phone. Ops join to the worker via the existing
        InternalServiceGuard'd workers read view if they need the (already-bounded) identity;
        this endpoint stays a PII-free projection of applications.

GET /workers/:workerId/applications
  Guard: InternalServiceGuard
  Response (Zod): { worker_id: uuid, applications: Array<{
      job_id: uuid, trade_key, title, city, area, action, reason, source_surface, rank,
      created_at, updated_at }> }
  (Joins jobs for the coarse, non-PII job fields. No employer, no pay.)
```

**Consent gate mechanism (recommendation, not yet built):** introduce a small reusable check —
`ConsentGuard` or a service assertion `assertWorkerConsented(workerId)` reading
`worker_consents` — and apply it to the three worker routes. Mirrors the profiling gate intent.
This is the one new shared primitive the alpha needs; flagged as OQ-1 below.

### 5. Build order (handed to engineer agents — not done here)

- **Stream A (database-architect):** `jobs` + `applications` tables + CHECK + unique index +
  idempotent seed (`packages/db/src/seed*.ts`) with ~10–20 jobs across the 15 alpha trades and
  stable UUIDs. Backward-compatible additive migration (§6 rollback note).
- **Stream B (backend-engineer):** the module(s), guards (incl. the consent gate, OQ-1), DTOs,
  repositories, and the three event emissions — reusing the resume controller's emit pattern.
- **Stream C (mobile/frontend):** wire the worker swipe UI to `/feed` + apply/skip; add the ops
  applicants view. Out of scope for this ADR.

---

## 6. EXPLICITLY OUT — hard Phase-2 boundary (do not drift)

This ADR builds a seeded apply/skip producer and **nothing else**. The following are restated
from ADR-0006 / CLAUDE.md §8 as a hard line; touching any of them requires a new team decision:

- **No employer posting / employer console.** Jobs are seeded only; there is no employer write
  path and no employer entity with PII.
- **No unlock / contact reveal.** Applying does not expose any contact in either direction.
- **No payments / payouts / boosts.** No economics anywhere.
- **No Reach ranking / scoring.** `score` stays `0`, `hot` stays `false`, `rank` is *seed
  display order* — not a relevance rank. The `@badabhai/reach-engine` core is NOT called by the
  alpha feed. (When it is, that is Phase 2.)
- **No real matching / PACE / PROTECT / LEARN.** No re-ranking from behaviour, no contact caps,
  no release waves.
- **No pay/salary field on `jobs`** (it belongs with the deferred unlock/economics).
- **LLMs do not touch this surface at all** — no profiling, scoring, or decisioning. Pure CRUD +
  events. (Invariant 4 trivially held.)

If the alpha "feed" starts to want any of the above, **stop and escalate** — that is the Phase-2
trigger, not an alpha tweak.

---

## 7. Consequences, risks, open questions

**Positive**
- The ADR-0006 event contracts get a real, honest producer with **zero schema churn** — the
  behavioural history starts accumulating "from day one" as ADR-0005/0006 intended.
- The eventual Phase-2 feed inherits exercised event plumbing and a proven `applications` shape;
  it only adds ranking + real producers on top.
- Strictly additive DB change; fully reversible (drop two unused tables).

**Risks / open questions to log (registers updated after sign-off, per instruction):**
- **OQ-1 (consent gate primitive):** there is no reusable "require active consent" guard in the
  API today. The alpha needs one (`ConsentGuard` / `assertWorkerConsented`). Small, but it is net
  new shared surface — confirm the mechanism at Stream B.
- **R-A (feed.shown volume):** one event per impression per fetch can grow the `events` table on
  repeated feed loads. Mitigation: bounded page size (`limit` ≤ 50, default 20) and, optionally,
  an idempotencyKey per (worker, job, day) for `feed.shown` to collapse repeat impressions. Decide
  at Stream B; not a blocker for alpha volumes.
- **R-B (scope-creep pressure):** the §6 boundary is the live risk — a "feed" invites Phase-2
  features. The boundary section is the mitigation; reviewers enforce it.
- **OQ-2 (taxonomy linkage):** `jobs.trade_key` should reference the 15-alpha-trade taxonomy
  (`packages/taxonomy`). Confirm the exact key list at Stream A so feed/profile trades align.
- **OQ-3 (RLS):** `applications` references `workers`; like the rest of Phase-1 it is accessed via
  the backend service role today (ADR-0004 / rls-plan). Add it to the RLS plan when RLS is
  finalised — not now, but log it.

**Migration version / rollback / backward-compat note (for Stream A, not authored here):**
- **Additive only:** two new tables + FKs + one CHECK + one unique index. No existing column is
  altered or dropped → CLAUDE.md §2 invariant 8 held; no risk to shipped data.
- **Forward:** `pnpm db:generate` from `schema.ts`, then `pnpm db:migrate`; seed runs after.
- **Rollback:** `DROP TABLE applications;` then `DROP TABLE jobs;` (drop child first for the FK).
  Both tables are new and unreferenced by any other table, so rollback is clean and data-loss is
  limited to alpha apply/skip rows + seed jobs (no Phase-1 data touched). The behavioural *events*
  already emitted persist in the `events` spine independently — rolling back the tables does not
  erase the audit trail.
- **Event compat:** none needed — no payload changes (§3).

**Doc-fix to do when the tables land (noted, not done here):** CLAUDE.md §4 still says
"DB tables (10)" and "10 tables" in the repo map; the repo already has 14 and these two make 16.
Update the count and the table list in the same PR that lands the migration. The
"PII lives only in `workers`" invariant remains accurate and unchanged.

---

## Related

- ADR-0006 (Reach foundation — defined these events as contract-ahead-of-producer; this ADR is
  the sanctioned, scoped producer for alpha)
- ADR-0005 (match substrate + day-one behavioural-record intent)
- ADR-0004 (PII-at-rest + RLS — `applications.worker_id` rides the service-role access model)
- `packages/event-schema/src/payloads.ts` (~L437–463), `registry.ts` (~L123–133)
- `packages/db/src/schema.ts`, `packages/db/src/seed*.ts`
- `apps/api/src/resume/resume.controller.ts` (guard + `events.emit` reference pattern)
- CLAUDE.md §2 invariants 1, 2, 4, 6, 8; §8 deferred list

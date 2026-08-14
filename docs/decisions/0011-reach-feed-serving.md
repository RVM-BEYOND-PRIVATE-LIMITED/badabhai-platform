# ADR-0011: Reach feed serving — ranked applicant list + worker job feed over the RANK core

- **Status:** Accepted (alpha-gate, architecture). Date **2026-06-15**. This is the
  decision row the team-decisions process requires before the serving slice is built.
- **Supersedes/relates:** **consumes** [ADR-0006](0006-reach-foundation-rank-core.md)
  (the deterministic RANK core in [`@badabhai/reach-engine`](../../packages/reach-engine))
  and **does not modify it**; builds on [ADR-0005](0005-metadata-driven-multi-profile-profiling.md)
  (the `worker_profiles` → match-signals projection). **Depends on** the **ops job-postings
  ADR** (the `job_postings` entity) for its real job source — but is **decoupled** from it
  via a `JobSource` port so it builds and tests against a stub now. Reuses the **existing**
  `feed.*` / `application.*` contracts in
  [`@badabhai/event-schema`](../../packages/event-schema) (no new event).

> **Numbering & cross-reference note (reconciled post-merge, 2026-06-15).** This ADR was
> drafted referring to the ops job-postings ADR as "ADR-0010"; on `main`, **0010 was
> independently assigned to [Contact Unlock + Reveal](0010-contact-unlock-and-reveal.md)**,
> and **[ADR-0009](0009-alpha-swipe-to-apply-seeded-jobs.md) is now the merged "alpha
> swipe-to-apply on seeded jobs"** (which ships a `jobs` + `applications` producer and
> already emits `feed.shown` / `application.*`). Therefore: (1) every "ADR-0010" below means
> **the ops job-postings ADR** — a *sibling alpha-gate branch, not yet merged*, to be
> **renumbered (≥0012)** at its own merge; (2) this Reach serving layer **coexists** with the
> ADR-0009 swipe surface (both legitimately emit `feed.shown` from different surfaces — no
> conflict, no payload change); (3) the `StubJobSource` → real `JobPostingsJobSource` swap is
> unaffected by the renumber.

## Context

ADR-0006 ratified and shipped the **deterministic RANK core**: `scoreWorkerForJob` and
`rankWorkersForJob` — pure, dependency-free, explainable, sort-never-block. It was
deliberately the *core* only; the surfaces that consume it were fenced off as Phase 2.
The behavioural event vocabulary (`feed.shown`, `application.submitted`,
`application.skipped`) was defined in `@badabhai/event-schema` but left **unemitted** —
a "contract ahead of producer".

The approved alpha gate needs the **first consumer** of that core: a way to actually
*see* a ranking. Two views are wanted on the internal ops console:

- **View A — payer applicant list:** for one job, the ranked pool of workers. This is
  exactly what the core already computes (`rankWorkersForJob(job, workers[])`).
- **View B — worker job feed:** for one worker, the ranked list of *jobs*. The core does
  **not** provide jobs-for-a-worker; it provides workers-for-a-job. View B must be
  **derived** by reusing the core's per-pair math, not by forking it.

The job entity (`job_postings`, ADR-0010) is **not merged**. We must not block serving
on it, and we must not invent a parallel job store. The alpha surface is the **internal
ops console, read-only** — no payer app, no worker app, no auth, no unlock/contact.

This ADR is the **architecture gate**: where serving lives, which contracts it touches,
how the seams stay clean, and how the §2 invariants are preserved. It produces **no
code, schema, or migration** — those are handed to the engineer agents afterward.

## Decision

Build a **strictly additive serving layer** in `apps/api` that **consumes** the RANK
core and renders two read-only ops views. Nothing in `@badabhai/reach-engine`, existing
tables, existing flows, or existing event payloads changes.

### 1. The serving seam (new module: `apps/api/src/reach/`)

A new NestJS domain module following the house convention
(`reach.controller.ts` → `reach.service.ts` → `reach.repository.ts` + `reach.dto.ts` +
`reach.module.ts`). It is the **only** place the core is wired to the database and to
events. It depends on three collaborators:

- **`@badabhai/reach-engine`** — imported, never modified. The serving layer calls
  `rankWorkersForJob` / `scoreWorkerForJob`; it does **not** reimplement scoring or
  ordering. This is the single source of ranking math (the AI-never-ranks pillar holds:
  no LLM is introduced anywhere on this path — see §invariants).
- **`reach.repository.ts`** — read-only Drizzle access to `worker_profiles` (the worker
  pool). It performs **no filtering** for relevance; it reads the pool, full stop.
- **A `JobSource` port** (interface, §4) — the seam over the not-yet-merged
  `job_postings`. The serving layer depends on the **port**, not the table.

Boundary mappers (`worker_profiles` row → `WorkerSignals`, job → `JobSpec`) live in the
serving layer as **pure functions** (`reach.mappers.ts`), unit-testable in isolation,
co-located with the only consumer. They are **not** added to `@badabhai/reach-engine`
(which must stay contract-free) and **not** scattered into the repository (which must
stay data-access). See §2 for the exact mapping.

### 2. View A — payer applicant list (`GET /reach/jobs/:jobId/applicants`)

1. Resolve the `JobSpec` for `:jobId` via the `JobSource` port (§4).
2. Read the **full** `worker_profiles` pool via the repository (alpha: in-memory full
   read — §open-item-5).
3. Map each row → `WorkerSignals` (§mapping).
4. `rankWorkersForJob(jobSpec, signals[])` → `RankedWorker[]`.
5. Render faceless rows: `workerId` (opaque), `rank`, `score`, `hot`, `pushEligible`,
   and the explainable `components[]` (`signal`, `raw`, `weight`, `reason`). **No**
   worker contact, **no** name, **no** employer identity.
6. Emit one `feed.shown` per rendered row (§3 / §open-item-3).

`count in == count out`: the response length equals the pool length. The view orders;
it never filters (§invariants, §open-item enforcement).

### 3. View B — worker job feed (`GET /reach/workers/:workerId/feed`)

The core gives workers-for-a-job; View B needs jobs-for-a-worker. We **derive** it by
**reusing `scoreWorkerForJob`**, not reimplementing it:

1. Read the worker's `worker_profiles` row → `WorkerSignals` (§mapping).
2. Enumerate candidate jobs via the `JobSource` port → `JobSpec[]` (alpha: all open
   jobs from the stub; production paging is a Phase-2 follow-up).
3. For each job, call `scoreWorkerForJob(jobSpec, workerSignals)` → a per-pair
   `WorkerJobScore` (`score`, explainable `components[]`).
4. **Order the jobs best-first** with the **same deterministic tie-break discipline the
   core uses** (score desc, then a stable secondary key, then `jobId`). This ordering is
   a thin orchestration in `reach.service.ts` — it does **not** copy the scoring math.
5. Assign a 1-based `rank` over the ordered jobs.
6. Render faceless job rows: opaque `jobId`, `rank`, `score`, `components[]`. **No**
   employer name, **no** raw job PII.
7. Emit one `feed.shown` per rendered row (`worker_id` = the feed's worker,
   `job_id` = the scored job).

**The orchestration lives in `reach.service.ts`** (open-item-2): a thin loop that calls
the core N times (once per candidate job) and sorts the results. It owns ordering and
`rank`; it owns **no** scoring. `count in == count out` over the candidate-job set.

### 4. The `JobSource` port (the ADR-0010 seam)

Serving depends on a narrow port, injected via NestJS DI, so the real `job_postings`
read drops in cleanly when ADR-0010 lands — with **zero** change to the serving logic:

```ts
// reach.job-source.ts (port the serving layer depends on)
export interface JobSource {
  /** One job mapped to the engine's demand-side type. null if absent. */
  getJobSpec(jobId: string): Promise<JobSpec | null>;
  /** All currently-open jobs as engine demand-side types (View B candidate set). */
  listOpenJobSpecs(): Promise<JobSpec[]>;
}
export const JOB_SOURCE = Symbol("JOB_SOURCE");
```

- **Now (alpha):** a `StubJobSource` provider returns a small fixed set of `JobSpec`s
  (deterministic fixtures, in-code, no table). View A and View B build and unit-test
  fully against it. The stub carries **only** `JobSpec` fields — opaque `jobId`,
  `roleIds`, centroid/`city`, travel/experience/pay/`neededBy` — never employer name or
  contact, so it is faceless by construction.
- **Post-ADR-0010:** a `JobPostingsJobSource` provider reads `job_postings` and maps
  rows → `JobSpec` (the `job_postings` → `JobSpec` mapper, sibling to the
  `worker_profiles` → `WorkerSignals` mapper). The DI binding for `JOB_SOURCE` flips from
  stub to real; the controller/service are untouched. This is the **only** intended
  coupling point to ADR-0010, and it is a single provider swap.

The port returns engine-typed `JobSpec`s, so the serving layer never imports
`job_postings` Drizzle types — keeping the seam clean and the swap mechanical.

**Drift guards (principal-engineer review — D6):**
- The stub's `jobId`s **must be real UUIDs.** `feed.shown.job_id` validates as
  `uuidSchema`, so a non-UUID stub id would throw at `createEvent`. Stub fixtures use
  generated UUIDs; `job_postings.id` (uuid) satisfies the same contract at swap time.
- **Gate the `JOB_SOURCE` binding so production never silently wires `StubJobSource`** —
  the real provider is required outside dev/test. The swap is one provider, but the
  default must not serve fixtures in a real environment.

### 5. Events — reuse `feed.shown`, defer `application.*`

- **`feed.shown` (reused, no new event):** emitted once per rendered row for both views,
  via the existing `EventsService.emit` path. The payload (`worker_id`, `job_id`, `rank`,
  `score`, `hot`) already fits both views exactly. For View B, `hot` is reported per
  §open-item-1. This makes `@badabhai/event-schema`'s "contract ahead of producer" a
  live producer at last, feeding the future LEARN history — PII-free by construction.
- **`application.submitted` / `application.skipped`: DEFERRED** (PM recommendation,
  accepted). The alpha surface is **read-only ops** — there is no worker app to apply or
  skip from, so there is no honest producer for these events yet. The **payloads stay**
  in `@badabhai/event-schema` unchanged; we emit them when the worker app ships. Adding
  an `apply`/`skip` endpoint now would either fabricate behaviour or sit dead — neither
  earns its keep at the gate.
- **No new event domain, subject type, or payload** is introduced. `feed`/`application`
  domains and the `job` subject type already exist (ADR-0006).

## Principal-engineer review amendments (2026-06-15)

A principal-engineer pass (recommendation sent to TL) reviewed every open decision against
alpha-speed / maintainability / migration-cost / architecture-fit and adversarially
verified each. Net for this ADR: **approve with one flip + four riders**, all folded in.

- **D7 — `feed.shown` is now UNKEYED** (open-item-3, **flipped** from the original
  per-render-batch keyed proposal). It belongs to the spine's unkeyed behavioural/
  impression family; an ephemeral `renderBatchId` key misuses the persisted-record-id
  convention and wouldn't dedupe real retries anyway. *This is the one reversal from the
  ADR as first drafted.*
- **D4 — View B omits `hot`/`pushEligible`** (open-item-1): confirmed (`hot=false`, no
  `pushEligible`); they have no cross-job meaning and no alpha push surface.
- **D5 — `application.*` deferred** (§5): confirmed, with a **rider** — add a contract
  test pinning `ApplicationSubmittedPayload`/`ApplicationSkippedPayload` against a
  `feed.shown`-shaped `{worker_id, job_id, rank}` tuple, so the deferred contract is
  verified-compatible at zero write cost (see Follow-ups).
- **D6 — `JobSource` port + `StubJobSource`** (§4): confirmed, with drift guards — stub
  `jobId`s must be real UUIDs (`feed.shown.job_id` is `uuidSchema`) and the binding must
  be gated so production never wires the stub.
- **D8 — in-memory full-pool, defer read-model** (open-item-5): confirmed, with two
  binding refinements — the repository projects **signal columns only** (never
  `embedding`/raw profile) and `count in == count out` is locked by a **property test**.

## The exact mapping: `worker_profiles` row → `WorkerSignals` (open-item-2)

A pure function in `reach.mappers.ts`. **Null/blank is the engine's job, not the
mapper's:** the mapper passes `null`/`undefined` straight through so the core applies its
neutral default — a blank field must **never** drop or penalize a worker (ADR-0006 §3,
§5; sort-never-block). The mapper **never** filters and **never** invents data.

| `WorkerSignals` field | `worker_profiles` source | Null handling |
| --- | --- | --- |
| `workerId` | `worker_id` (opaque UUID) | always present (PK ref) |
| `roleId` | `canonical_role_id` | `null` if blank → engine neutral-defaults role |
| `secondaryRoleIds` | derive from `canonical_trade_id` / taxonomy adjacency if available, else `[]` | empty array, never null-drop |
| `experienceYears` | `experience` JSONB → `total_years` (number) | `null` if missing/unparseable |
| `expectedSalary` | `salary_expectation` JSONB → monthly INR | `null` if missing |
| `location` | `location_preference` JSONB → **city-centroid** (ADR-0005), never a precise point | `null` if no centroid |
| `city` | `location_preference` JSONB → city slug | `null` if missing |
| `travelRadiusKm` | `location_preference` JSONB → travel willingness | `null` → engine option default |
| `availability` | `availability` JSONB → enum (`immediate`/`notice_period`/`not_looking`/`unknown`) | `unknown`/`null` → neutral |
| `lastActiveDaysAgo` | derived from `updated_at` (days since) | `null` if not derivable |

Notes:
- **No PII crosses the mapper.** Only canonicalized, non-identifying signals and the
  opaque `worker_id` are read. Name/phone/address live only in `workers` and are never
  touched by serving.
- **`lastActiveDaysAgo`** is derived at request time from `updated_at`. Because the core
  is deterministic *given its inputs*, this clock-derived value is computed **outside**
  the engine (in the mapper) so the engine itself stays clock-free (ADR-0006); the
  serving layer owns this single non-deterministic input and it affects ordering only,
  never inclusion.
- The `job_postings` → `JobSpec` mapper (post-ADR-0010) follows the same discipline:
  pass-through nulls, faceless fields only, no filtering.

## Resolved open items

1. **`hot` / `pushEligible` semantics for View B (job feed).** The core computes these
   relative to a *worker-set for one job* (`hot` = top `hotFraction` of that set *and*
   on-trade; `pushEligible` = clears the push floor). In View B we rank *jobs for one
   worker*, so a cross-job "top fraction" tag has no equivalent meaning and
   `pushEligible` (a push-notify gate to workers) has no surface (read-only ops, no
   notifications).
   - **Decision:** **View B reports `hot = false` for all rows and omits `pushEligible`
     from the View-B response/event.** `feed.shown` carries `hot=false` for View-B
     impressions (the payload's `hot` defaults to `false`; honest, not fabricated).
     `score` and the explainable `components[]` carry all the View-B signal. We do **not**
     recompute a per-job-set `hot` (that would invent a meaning the core never defined)
     and we do **not** reinterpret `pushEligible` as a job-side gate (push to whom?).
     When the worker app + PACE/PROTECT land, a worker-side notify policy can be designed
     deliberately in Phase 2 — not faked here. **View A keeps the core's `hot`/
     `pushEligible` as-is** (it is exactly the set the core was built for).

2. **Where View-B orchestration + mappers live.** Orchestration (the N-times
   `scoreWorkerForJob` loop + ordering + `rank`) lives in **`reach.service.ts`** (API
   service layer). Mappers (`worker_profiles`→`WorkerSignals`, `job_postings`→`JobSpec`)
   live in **`reach.mappers.ts`** as pure functions in the same module — **not** in the
   engine (keeps it contract-free) and **not** in the repository (keeps it data-only).
   Column→signal mapping + null handling specified above.

3. **`feed.shown` granularity / idempotency.** One `feed.shown` per **rendered row per
   load**. An ops page-load is a legitimate impression.
   - **Decision (amended by the principal-engineer review — D7, FLIPPED from the original
     keyed proposal): emit `feed.shown` UNKEYED** (no `idempotencyKey`), matching the
     spine's other behavioural/impression events (`action.recorded`,
     `worker.otp_requested`). Each render is an honest impression; LEARN windows/dedupes
     impressions downstream, which is where that policy belongs.
   - **Rationale for the flip:** the repo's `idempotencyKey` convention keys on a
     **persisted record id** (a durable fact — `consent_id`, `note_id`), not an
     **ephemeral per-response UUID**. A `renderBatchId` key would be a *new*
     "transmission-dedup" semantic dressed up as the entity-dedup convention, and it would
     not even collapse real retries (a re-entered handler mints a fresh batch id, so
     nothing dedupes). Phase-2 plans a deliberate **per-worker-session window** for
     impressions — a different philosophy — so an interim batch key is throwaway. Unkeyed
     is less code, holds every §2 invariant identically, and defers the windowing decision
     to where it belongs. `feed.shown` stays PII-free; ops viewing writes no actor PII.
   - *(If the team later wants to collapse buffered-response replays specifically, a key
     MAY be added then — but documented as transmission-dedup, NOT the entity convention,
     and covered by tests.)*

4. **The `JobSource` seam/stub contract.** Specified in §4: the `JobSource` port
   (`getJobSpec`, `listOpenJobSpecs` → engine-typed `JobSpec`s), a `StubJobSource` for
   alpha, and a `JobPostingsJobSource` provider that drops in via the `JOB_SOURCE` DI
   binding when ADR-0010 lands. No parallel job store; one provider swap.

5. **Read-model / index.** **Confirmed:** for alpha, a plain **in-memory full read of
   `worker_profiles` → score the whole pool per request** is sufficient and is the
   *correct* choice because it makes **sort-never-block trivially true** — the pool read
   has no `WHERE` relevance filter, so `count in == count out` is structural, not a
   property to police. **No additive index is recommended for alpha** (none needed at the
   pool size, and any index risks tempting a relevance filter).
   - **Repository projection discipline (principal-engineer review — D8): the reach
     repository projects ONLY the signal columns the mapper needs** (canonical
     role/trade, the experience/salary/location/availability JSONB, `updated_at`, and the
     opaque `worker_id`). It **never** selects `embedding` or any raw-profile/PII column.
     The Phase-2 read-model must keep the identical projection.
   - **Lock `count in == count out` with a property test** (D8) the Phase-2 read-model
     must also pass: no relevance `WHERE`; pool length == View-A response length,
     candidate-job count == View-B response length.
   - **Production scaling concern (Phase-2 follow-up, NOT an alpha blocker):** full-pool
     scoring per request does not scale to large pools / many concurrent payers. The
     Phase-2 answer is a precomputed/cached **read model** for the rank input — and it
     must (a) add **no new PII location** (signals + opaque ids only, same facelessness)
     and (b) preserve sort-never-block (a cache of *signals*, not a *filtered shortlist*).
     Tracked as tech-debt, deferred.

## Invariants (CLAUDE.md §2) — how this design holds them

- **Event-first.** Every important new endpoint emits a validated event: both views emit
  `feed.shown` per row via `createEvent`/`EventsService`. Reused, not invented.
- **No raw PII.** Responses, events, and logs carry opaque `worker_id`/`job_id`, ranking
  signals, and explainable `components[]` only — **faceless**. No name, phone, address,
  employer name, or contact anywhere on the path. Raw PII stays only in `workers`, which
  serving never reads.
- **LLMs never rank/score/decide.** No LLM is introduced on this path. Ranking is the
  deterministic `@badabhai/reach-engine` core, exclusively. Stated and enforced by the
  module having **no** AI-service dependency.
- **SORT-NEVER-BLOCK, end to end.** Made an explicit, testable boundary contract: the
  serving layer performs **no relevance filtering**. **View A:** `applicants.length ===
  pool.length`. **View B:** `feed.length === candidateJobs.length`. `hot`/`pushEligible`/
  ordering change order only, never membership. This is asserted with property/unit tests
  (a worker/job with all-blank signals still appears, just ranked low; an off-trade
  worker appears, never `hot`).
- **DPDP consent gate.** Serving reads `worker_profiles`, which only exist post-consent
  (a profile is produced after `consent.accepted`); serving adds no new pre-consent
  processing. (Read-only, internal ops; no new worker-facing processing.)
- **Typed contracts at every boundary.** DTOs are Zod (`reach.dto.ts`); engine I/O is the
  engine's TS types; the `JobSource` port is a typed interface. No untyped boundary.
- **Backward compatibility.** No event payload mutated, no DB column dropped, no schema
  change at all (additive serving + stub). `feed.shown` is consumed exactly as shipped.

## Out of scope — fenced off (do not build at this gate)

- **PACE** (release waves), **PROTECT** (contact caps, scraper blocking), **LEARN**
  (behavioural re-ranking) — all Phase 2.
- **`application.submitted` / `application.skipped` endpoints** — deferred (no producer
  surface; payloads retained, emitted when the worker app ships).
- **Unlock / contact reveal / payments / payouts / boosts** — Phase 2.
- **Worker app and payer app + auth** — alpha surface is internal ops, read-only.
- **Any change to `@badabhai/reach-engine`** — serving consumes it unchanged; no new
  signal (incl. Skills), no weight change, no API change to the core.
- **`job_postings` / `jobs` entity itself** — owned by ADR-0010 / ADR-0009; serving only
  *reads* via the `JobSource` port and must not create a parallel job store.
- **A production read-model/index** — Phase-2 follow-up (alpha uses full-pool scoring).

## Consequences

- **First real consumer of the RANK core.** ADR-0006's "contract ahead of producer"
  becomes a live producer: `feed.shown` finally emits, seeding LEARN history (PII-free).
- **Clean ADR-0010 decoupling.** Serving builds and ships against a `JobSource` stub
  today; the real `job_postings` read is a single DI provider swap with no serving-logic
  change — the two alpha-gate slices proceed in parallel.
- **New module surface** in `apps/api` (`reach/`) and **new read-only ops-console views**
  (applicant list, worker feed). Additive only; existing flows/tables/events untouched.
- **Determinism preserved.** The one clock-derived input (`lastActiveDaysAgo`) is
  computed in the serving mapper, outside the engine, keeping the core clock-free; it
  affects order only, never inclusion.
- **Known alpha limitation:** full-pool scoring per request. Acceptable at alpha scale;
  the production read-model is a tracked Phase-2 follow-up, not a blocker.
- **Reversible.** The module, views, stub, and `feed.shown` emission can be removed
  without touching the core or the schema; rollback is "stop mounting the `reach` module
  + drop the ops views". No migration to unwind.

## Follow-ups (tracked)

- **Swap `StubJobSource` → `JobPostingsJobSource`** when ADR-0010 (`job_postings`) merges;
  author the `job_postings` → `JobSpec` mapper at that time.
- **Emit `application.submitted` / `application.skipped`** when the worker app ships
  (payloads already defined). **Now (D5 rider):** a contract test pins both payloads
  against a `feed.shown`-shaped `{worker_id, job_id, rank}` tuple so the deferred contract
  is verified-compatible before there is a producer.
- **Production read-model / index** for the rank input (no new PII location;
  sort-never-block preserved) — Phase 2 / scaling.
- **Worker-side notify policy** (the deliberate Phase-2 answer to View-B `pushEligible`,
  designed with PACE/PROTECT) — deferred.
- Update [architecture-log.md](../registers/architecture-log.md) and the
  [overview](../architecture/overview.md) when the serving module lands (new consumer
  seam: `reach` module + `JobSource` port; `feed.shown` now emitted).

*This ADR records the architecture decision for Reach feed serving (2026-06-15). It
authorizes a strictly additive serving layer that **consumes** the unchanged RANK core;
no code, schema, or migration is produced here — implementation is handed to the engineer
agents.*

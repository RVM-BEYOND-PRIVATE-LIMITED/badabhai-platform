# ADR-0006: Reach foundation — deterministic RANK core + behavioural event contracts

- **Status:** Proposed (awaiting owner sign-off — crosses the Phase-1/2 boundary)
- **Date:** 2026-06-11
- **Supersedes/relates:** starts paying down **TD8** (`reach-engine` placeholder); builds
  on **ADR-0005** (the match substrate + the behavioural-events deferral) and the locked
  behaviour spec *"BadaBhai — The Matching Algorithm, in Plain English"*. Adds to the
  governed event contract (`@badabhai/event-schema`). This is the **decision row** the
  team-decisions process requires before any Phase-2 work begins.

## Context

The matching algorithm is locked (the plain-English report). Its day-one design is
explicitly **rules-based and works with zero data** (§10): *"At launch, the engine ranks
using the common-sense checklist… that's deliberate: it works on day one with no usage
history."* So the **scoring + ranking core** is buildable now, in isolation, without the
Phase-2 surfaces that consume it. `@badabhai/reach-engine` was a throwing placeholder
(TD8). The task: "score + order workers for a job (sort-never-block) + feed/apply-skip
events."

## Decision

Implement only the **deterministic RANK core** + the **behavioural event vocabulary** —
not the surfaces around them.

**1. `@badabhai/reach-engine` — pure, dependency-free scoring + ranking.**
- `scoreWorkerForJob(job, worker)` — the §3 weighted checklist: role (.35), distance
  (.20), experience (.15), pay (.10), availability (.10), activity (.10). Unknown signals
  get a **neutral default** (benefit of the doubt — the chat can ask later), never a
  penalty, so a blank field never drops a worker and a fuller/more-active profile ranks
  higher (§5). Deterministic (no clock/randomness), explainable (per-signal `reason`).
- `rankWorkersForJob(job, workers, opts)` — **sort, never block**: the output always
  contains every input worker (no filtering). Best-first, ties broken by recency then
  `workerId` (stable, reproducible). The **hot** tag marks the top `hotFraction`
  (default ~12%) **and** is gated on a real candidate (role raw > 0) → an off-trade worker
  is never hot, even at rank 1 (§8.5). `pushEligible` marks who clears the push-notify
  floor; everyone below still appears (§12 dials).
- Inputs are contract-free types (`JobSpec` / `WorkerSignals`); a Phase-2 caller maps
  `worker_profiles` → `WorkerSignals` at the boundary.

**2. Behavioural event contracts (`@badabhai/event-schema`) — PII-free, defined now.**
- `feed.shown` (a job surfaced to a worker: `rank`, `score`, `hot`), `application.submitted`
  (worker applied), `application.skipped` (worker dismissed; **enum-only** reason, no free
  text). New `EVENT_DOMAINS` (`feed`, `application`) + `SUBJECT_TYPES` (`job`). Carry
  `worker_id` + an opaque `job_id` + ranking signals only — never employer name, pay, or
  worker contact. **Emitted when the Phase-2 feed surface ships**, so LEARN has history
  (§10–§11 "captured from day one").

**Explicitly OUT of scope (Phase 2 — not built here):** the job/employer entity, the
worker feed, unlock/contact, payments, **PACE** (release waves), **PROTECT** (contact
caps, scraper blocking), **LEARN** (behavioural re-ranking), and the job-side of the
distance computation. **LLMs must never rank/decide matches — this engine does.**

## Consequences

- **TD8 → paying down.** The engine is real, pure, fully unit-tested (sort-never-block,
  partial-profile tolerance, off-trade-never-hot, determinism, NaN/zero-input hardening).
- The new event domains/subjects are **additive** to the governed contract; the events are
  **defined but unemitted** until the feed surface exists (a deliberate "contract ahead of
  producer", consistent with ADR-0005's day-one-behavioural-record intent).
- The day-one scoring **weights/dials are fixed in shape but tunable** (§12); they are not
  learned yet (LEARN is Phase 2).
- A Phase-2 caller must map `worker_profiles` → `WorkerSignals` (incl. the geo city-centroid
  + recency from ADR-0005) — that mapping is where the match model meets the engine.

## Follow-ups (Phase 2, tracked)

- The **job/employer entity** + the **worker feed** surface (the producers of these events).
- The `worker_profiles` → `WorkerSignals` projection (geo, recency, typed match fields).
- Emitting `feed.shown` / `application.*` from the feed; PACE/PROTECT/LEARN; unlock/contact
  + payments; the agency dual-channel attribution.

*This ADR records the foundation decision for sign-off. The engine + event contracts are
implemented; the Phase-2 surfaces are not.*

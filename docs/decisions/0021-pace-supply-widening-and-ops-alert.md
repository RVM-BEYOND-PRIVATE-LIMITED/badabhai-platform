# ADR-0021: PACE supply-widening + ops alert (deterministic "release waves")

- **Status:** **Accepted — PHASE-0 scope + design human-signed 2026-06-19.** Build **LANDED
  additively** (Phase-2 alpha-gate) under the [ADR-0014](0014-phase-1-schema-foundation-stable.md)
  additive-only policy. **PACE is INERT by default** (`PACE_ENABLED=false`); the **adjacent-trade
  leg is GATED** on a ratified adjacency map that does **not exist yet** (see §Escalations) — only
  the **AREA-widen + OPS-ALERT** legs ship enabled-capable. Real worker-app push waves remain OUT.
- **Date:** 2026-06-19
- **Phase:** Phase-2 alpha-gate (strictly additive; deterministic; no LLM)
- **Builds on / amends:**
  - [ADR-0011](0011-reach-feed-serving.md) — defines the **PACE / PROTECT / LEARN** triad and
    **defers PACE** ("release waves"). This ADR implements the **supply-widening + ops-alert slice**
    of PACE. PROTECT and LEARN remain deferred; the RANK core is reused, never modified.
  - [ADR-0015](0015-reach-feed-on-real-jobs.md) — the live `jobs` entity + the faceless
    `JobSignalRow` projection PACE reads supply from.
  - [ADR-0006](0006-reach-foundation-rank-core.md) — the deterministic RANK core (`hot`/floor) PACE
    counts; the AI-never-ranks pillar (invariant 4) is untouched.

---

## Context

Reach serves a ranked applicant pool per job (sort-never-block). But when a job has **thin good-fit
supply** — too few above-floor (on-trade) candidates — nothing widens the net. ADR-0011 named the
fix (PACE "release waves") and deferred it.

We want, for a thin-supply job, a **deterministic, rules-based** escalation that **only ADDS**
candidates over a 6–24h window, and — if supply stays thin — a **PII-free ops alert** for human
intervention. No model may decide anything here (invariant 4).

**Two data gaps shape the scope:**
- **Adjacency:** the engine scores `secondaryRoleIds` at the lower secondary weight (0.6, below
  on-trade), but `reach.mappers` returns `[]` and the taxonomy has **no `ADJACENT_ROLES` map**.
  Hospitality explicitly declined one (product call 2026-06-17); industrial adjacency is draft only.
  → the adjacent-trade leg is **gated** (see §Escalations).
- **Area without coordinates:** the live `jobs` projection has no centroid (city-slug distance), so
  raising `maxTravelKm` only widens supply where coordinates exist (enriched/stub jobs). The
  mechanism is correct; its reach depends on a later centroid-enrichment follow-up.

## Decision

**D1 — Escalation order (fixed, deterministic).** For a thin-supply job:
`base → widen AREA (raise the travel band in config steps to a ceiling) → [gated] widen ADJACENT
trade → OPS ALERT`. Exactly one lever escalates per wave. The **widen decision is a pure function**
(`pace.decision.ts`: `(supply, elapsedHours, stage, currentAreaKm, config) → action`) — no I/O, no
clock, no model. The service applies it; scheduling uses real time but is tested via an injected clock.

**D2 — "Thin supply" = above-floor on-trade count.** PACE counts candidates the RANK core flags
`hot` (the **same floor the boost-integrity guard locks**), via `rankWorkersForJob` over the full
pool (reused, never reimplemented). Widening only **raises the band / adds adjacency below on-trade**,
so it can only **ADD** — sort-never-block and the floor are preserved; nobody is hidden, dropped, or
re-ranked.

**D3 — Waves are DELAYED BullMQ jobs.** PACE is the **first delayed/scheduled-job consumer** of the
live BullMQ wiring (`queue.module.ts`). Each wave is enqueued with a `delay` (cadence
`PACE_WAVE_INTERVAL_HOURS`); the processor re-evaluates and schedules the next, or terminates. Emits
are idempotency-keyed (`pace.wave_widened:{job}:{wave}`, `pace.ops_alert_raised:{job}`) so a stalled-
job redelivery cannot double-widen or double-alert. **DevOps must validate the delayed-job path + a
Worker that survives the 6–24h window** (in-process today → the API process must stay up).

**D4 — New v1 events (PII-free & faceless).** `pace.wave_widened {job_id, stage, supply_count,
elapsed_hours}` and `pace.ops_alert_raised {job_id, supply_count, elapsed_hours}` — opaque job_id +
the stage enum + counts + elapsed only; never a worker, employer, or location. No shipped payload
mutated (invariant 8).

**D5 — Additive `pace_states` table (faceless).** One row per job under PACE (stage, wave,
`current_area_km`, `last_supply_count`, `ops_alert_raised`, `started_at` = the window clock). Opaque
`job_id` is the only reference (FK to the faceless `jobs`); RLS-locked per the spine posture (TD20).

**D6 — Inert + gated by config.** `PACE_ENABLED` (default off) gates the whole feature;
`PACE_ADJACENCY_ENABLED` (default off) gates the adjacent-trade leg and is a **no-op until a ratified
map is wired**. Thresholds/steps/cadence are config (`PACE_THIN_SUPPLY_MIN`, `PACE_AREA_STEP_KM`,
`PACE_MAX_AREA_KM`, `PACE_WAVE_INTERVAL_HOURS`, `PACE_OPS_ALERT_AFTER_HOURS`) — nothing hard-coded.

**D7 — Alpha scope.** "Widen" = adjust the **served good-fit pool** (the area band feeding the ops
applicant view) + raise ops alerts. **OUT:** real worker-app push waves, telephony. The
ops-intervention surface is a read-only faceless PACE-alert view, riding the same unauthenticated
ops-surface as `reach` in alpha (cross-link R22).

## Consequences

- A thin-supply job deterministically widens its served pool and, if still thin past the window,
  surfaces a PII-free ops alert — with no LLM and no PII anywhere on the path.
- Area-widen's effect is bounded by coordinate enrichment (city-slug jobs see no area change); on
  that path PACE escalates to the ops alert, which is the valuable alpha outcome. The wave/event/
  ops-alert machinery is fully exercised (tests use coordinate-bearing specs).
- The adjacent-trade leg is built but inert until a ratified map exists (§Escalations).

## Escalations (out / human-gated)

- **Ratified industrial `ADJACENT_ROLES` map (product/CEO).** The adjacent-trade leg stays gated
  until one exists. Tracked: [pace-adjacency-ratification-escalation.md](../registers/pace-adjacency-ratification-escalation.md),
  open-question Q-PACE-ADJ, and the tech-debt register. **Do not wire a draft or invent a map.**
- **Coordinate enrichment** for jobs/workers so area-widen meaningfully widens the city-slug pool.
- **Real worker-app push / telephony** waves — separate human-gated provider streams.
- **Ops-surface auth** (R22) when the ops console gains per-actor auth.

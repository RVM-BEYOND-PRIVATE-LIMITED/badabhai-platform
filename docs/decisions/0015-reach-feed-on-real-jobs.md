# ADR-0015: Reach feed serving on the real `jobs` entity

- **Status:** Accepted (2026-06-17)
- **Phase:** Phase-2 alpha-gate (strictly additive; the RANK core is unchanged)
- **Builds on:** [ADR-0011 — Reach feed serving](0011-reach-feed-serving.md) (the §4 `JobSource`
  swap point + the two views), [ADR-0006 — Reach RANK core](0006-reach-foundation-rank-core.md)
  (the deterministic scorer, **not modified**), [ADR-0009 — alpha swipe-to-apply](0009-alpha-swipe-to-apply-seeded-jobs.md)
  (the `jobs` entity + `applications`).
- **Closes:** the ADR-0011 §4 swap (the alpha `StubJobSource`) and pays down [TD36(c)](../registers/tech-debt-register.md).

---

## Context

Reach serving (ADR-0011) shipped over a dev-only `StubJobSource` (in-code `JobSpec`
fixtures) behind a `JobSource` port, with the real read deferred to "when the job entity
is ready" (TD36c). The two views already exist and are unchanged:

- **View A** — payer ranked applicant list: `rankWorkersForJob(job, fullWorkerPool)`.
- **View B** — worker ranked feed: `scoreWorkerForJob(job, worker)` over open jobs.

Decision (maintainer, 2026-06-17): serve the **real `jobs` entity** (ADR-0009 swipe-to-apply
— the entity workers actually apply to), with **full ranking fidelity** (all six factors fire),
and keep **View A as the full candidate pool** (sourcing, the ADR-0011 semantic). The
matching algorithm is unchanged — weights stay Role .35 / Distance .20 / Experience .15 /
Pay .10 / Availability .10 / Activity .10.

## Decision

1. **Real `JobsTableJobSource`** (binds `JOB_SOURCE` in `reach.module.ts`, replacing the
   dev-only `StubJobSource` + its `isDevEnv` D6 gate). It reads the live `jobs` table through
   a **faceless projection** and maps each row → `JobSpec` via a pure `jobSignalRowToJobSpec`.
   The controller/service are untouched — a single provider swap, exactly as ADR-0011 §4 designed.

2. **The mapper is the faceless/PII boundary** (TD36c). The repository projection (`JobSignalRow`)
   selects ONLY ranking signals — `id`, `trade_key`, `city`, and the new demand columns — and
   **never** `title` / `area` / `payer_id` (free text / billing linkage). A `JobSpec` therefore
   can never carry an employer-y string or a payer link into a `feed.shown` event or a log.
   A unit test asserts the projection + mapper expose only `JobSpec` keys.

3. **Demand-side signal columns on `jobs`** (additive, all NULLABLE, PII-free; migration 0018):
   `pay_min`, `pay_max`, `min_experience_years`, `max_experience_years`, `needed_by`
   (`immediate|soon|flexible`), with non-negative + max≥min + enum CHECKs. The engine
   neutral-defaults a null, so a blank never drops or penalizes anyone (sort-never-block holds).
   Role uses the existing `trade_key`; Distance uses the existing `city` slug — no column needed
   for either. The seed populates coarse, realistic per-trade values so the demo ranks meaningfully.

4. **Trade→role bridge — reuse, don't reinvent.** Jobs carry one of 15 `trade_key`s; workers
   canonicalize into the closed 7-`role_*` set. The Role factor exact-matches `job.roleIds`
   against a worker's `canonical_role_id`, so the JobSource builds `roleIds` from the **existing**
   authored `taxonomy_role_ids` map in [`trade-content.ts`](../../apps/api/src/resume/trade-content.ts)
   (`roleIdsForTradeKey`). The 5 machining trades map to the 7 worker roles; the other 10 trades
   yield `[]` — which is **correct**: Phase-1 only profiles CNC/VMC machinists, so no worker
   matches those trades on role (they still appear, ranked lower — sort-never-block).

5. **Distance uses the city-slug fallback.** The RANK core scores Distance by `city` equality
   when no coordinates are present (`same city → 0.9`, `different → 0.3`). No centroids are
   stored or derived — finer haversine distance is a future enhancement, not a blocker.

## Invariants held

- **RANK core untouched** (`@badabhai/reach-engine` not modified).
- **Faceless / no PII:** ids + enums + integer signals only; no employer free text / payer link
  in any `JobSpec`, `feed.shown` event, or log.
- **Additive / backward-compatible:** new nullable columns only; no shipped column/event/payload
  changed; `feed.shown` is unchanged (job_id is the real `jobs.id` uuid).
- **Sort-never-block:** View A still ranks the full pool; missing signals are neutral, never a filter.

## Consequences / follow-ups (TD36)

- (a) full-pool scoring per request and (d) N `feed.shown` per page-load remain Phase-2 scaling
  items. (b) `secondaryRoleIds` is still dormant (no adjacency lookup). NEW: the 10 non-machining
  trades have no worker-role match until the worker taxonomy widens beyond the 7-role set; and the
  trade→role bridge lives in `trade-content.ts` — it could move to `@badabhai/taxonomy` when a
  second consumer appears. Reach endpoints remain unauthenticated (R22).

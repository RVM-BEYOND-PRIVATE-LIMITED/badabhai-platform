# @badabhai/reach-engine

The deterministic **RANK core** of the Reach Engine (TD8, ADR-0005) — pure,
dependency-free TypeScript. Given a job and a set of workers it scores each worker's
relevance and orders them best-first, flagging the "hot" top ~10–15%.

The cardinal rule is **sort, never block**: every worker passed in appears in the
output. Ordering only changes what you see *first*; it never hides anyone.

## API

```ts
import { scoreWorkerForJob, rankWorkersForJob } from "@badabhai/reach-engine";

const score = scoreWorkerForJob(job, worker);   // { score 0..1, components[] (explainable) }
const ranked = rankWorkersForJob(job, workers); // RankedWorker[] (best-first, rank, hot, pushEligible)
```

- **`scoreWorkerForJob`** — the §3 checklist on the **2026-06-19 CEO weight ledger**
  ([ADR-0033](../../docs/decisions/0033-rank-skills-overlap-factor.md)): role (.35),
  distance (.20), **skills (.15)**, experience (.15), pay (.10), availability (.05),
  activity (0 — kept as an explainable component + the ranking tie-break). Unknown
  signals get a neutral default (benefit of the doubt — the chat can ask later), never
  a penalty, so a blank field never drops a worker and a fuller/stronger profile
  naturally ranks higher. Deterministic (no clock/randomness) — works on launch day
  with no data.
- **`skillsOverlap`** (ADR-0033) — the deterministic skills factor:
  `|worker ∩ jobRequired| / |jobRequired|` over canonical closed-set `skill_id` tokens
  (exact equality only — **never embeddings/similarity/a model**, invariant #4). A job
  that lists no skills redistributes the weight (its ordering is untouched by the
  factor); a worker with no confirmed skills scores 0 on this factor only — never a
  block.
- **`rankWorkersForJob`** — scores all, orders best-first (ties broken by recency then
  `workerId` for a stable, reproducible order), and never filters. The **hot** flag marks
  the top `hotFraction` (default ~12%) **and** requires a real candidate (role raw > 0),
  so an off-trade worker is never "hot". **`pushEligible`** marks who clears the
  push-notify floor; everyone else still appears.

Inputs are plain, contract-free types (`JobSpec` / `WorkerSignals`) — a caller maps
`worker_profiles` → `WorkerSignals` at the boundary.

## Out of scope (Phase 2)

LLMs must **never** rank/decide matches — this engine does. The surfaces that *consume*
it are intentionally not here: the job/employer entity, the worker feed, unlock/contact,
payments, **PACE** (release waves), **PROTECT** (contact caps, scraper blocking), and
**LEARN** (behavioural re-ranking). The `feed.*` / `application.*` events
(`@badabhai/event-schema`) are defined but emitted only when the feed surface ships.

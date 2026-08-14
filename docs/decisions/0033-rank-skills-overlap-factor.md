# ADR-0033: Deterministic skills-overlap factor in RANK (weight 15)

- **Status:** Accepted — owner ruling 2026-07-17 ([team-decisions.md](../registers/team-decisions.md), "Context-drift register rulings", item 2).
- **Date:** 2026-07-17
- **Supersedes:** [ADR-0006](0006-reach-foundation-rank-core.md)'s *"Ratified scope vs the
  locked weight columns"* section — specifically its direction that *"the implemented weights
  are the source of truth and the ledger's columns are a draft (the doc is reconciled to the
  code, not the reverse)"*, and the 2026-06-12 team-decision row that ratified it. ADR-0006's
  RANK contract (sort-never-block, neutral defaults, determinism, explainability, LLMs-never-rank)
  is otherwise **untouched and still binding**.
- **Relates:** [ADR-0030](0030-embedding-skill-canonicalization.md) (the `skill_id` closed set
  this factor consumes; its TAX-6 invariant-#4 lock test is edited **in this same diff**, per
  that test's own instruction) · [ADR-0011](0011-reach-feed-serving.md)/[ADR-0015](0015-reach-feed-on-real-jobs.md)
  (the serving layer) · [ADR-0017](0017-learn-layer-offline-rank-calibration.md) (LEARN, offline —
  see Consequences) · [context-drift register](../registers/context-drift-2026-07-16.md) row **A-2**.

## Context

### The ruling chain (three dated decisions, in order)

1. **2026-06-12 — code-wins, ratified.** ADR-0006 shipped the deterministic RANK core with six
   signals (Trade .35 / Location .20 / Experience .15 / Pay .10 / Availability .10 / Activity .10)
   and **no skills signal**. It explicitly recorded the master-context ledger's Σ100 — which
   *does* list "Skills 15" — as a **draft**, and ratified the direction *doc → reconciled to code*.
   The [team-decisions row](../registers/team-decisions.md) of the same date re-confirmed it.
2. **2026-06-19 — the CEO weight lock.** A CEO decision pinned the RANK ledger as
   **Trade 35 / Location 20 / Skills 15 / Experience 15 / Salary 10 / Availability 5** and directed
   that *"code must be reconciled TO these (add Skills, drop Activity)"*, superseding the older
   "implemented weights authoritative" row. It is recorded in
   [`.claude/project-memory.md:52`](../../.claude/project-memory.md) — but it **never landed as a
   decision row** (team-decisions stopped at 06-15) and **was never implemented**.
3. **2026-07-17 — the owner confirmation.** The [context-drift register](../registers/context-drift-2026-07-16.md)
   surfaced the contradiction as row **A-2** plus an explicit governance question: *"is the 06-19
   lock operative?"* The owner ruled: **the 2026-06-19 CEO weight lock IS OPERATIVE** — *"the new
   decision supersedes the CEO's older decision"* — i.e. it overrides ADR-0006's ratified
   code-wins direction **for the weight ledger**. Consequence, quoted from the ruling: *"a
   deterministic skills factor (weight 15) enters RANK via its own ADR, which must edit
   `packages/reach-engine/src/no-skills-in-rank.test.ts` in the same diff… LLMs/embeddings still
   never rank (invariant #4) — the factor is closed-set `skill_id` overlap, deterministic."*

This ADR is that ADR. **The governance direction is now settled and should not be re-litigated
from either side:** for the RANK **weight ledger**, the CEO lock is the source of truth and the
code is reconciled to it. (This does **not** invert the doc↔code rule generally — the
[drift register's governing rule](../registers/context-drift-2026-07-16.md) still stands:
decisions flow doc→code, build-state flows code→doc.)

### What made this a hard-to-reverse change (and why it needed an ADR, not a tweak)

TAX-6 deliberately **locked skills out of RANK** with a CI test that greps every non-test source
in `reach-engine` + `apps/api/src/reach` for `/skill/i` and `/embedding/i`. Implementing the
ledger **breaks CI by design** — the lock test anticipated exactly this and carried its own
amendment instruction. That instruction is honoured here.

## Decision

### 1. The factor — `skillsOverlap(workerSkillIds, jobSkillIds)`

A pure function in [`scoring.ts`](../../packages/reach-engine/src/scoring.ts), exported from the
package:

```
skillsOverlap = |worker ∩ jobRequired| / |jobRequired|
```

over **deduplicated canonical closed-set `skill_id` tokens** (the ADR-0030 vocabulary), compared
by **exact string equality only**. Blank/non-string entries are dropped on both sides before the
comparison, so a corrupt list degrades to "fewer known ids" — never a throw, never a penalty on
another factor. Bounded `[0,1]`, monotonically non-decreasing in the overlap.

**Invariant #4 is absolute and structurally preserved.** The factor performs **no embedding, no
similarity, no vector maths, no model call, no network, no clock** — it is set intersection over
opaque tokens. The vector layer assigns those ids **upstream** (at profiling/posting time, ADR-0030
SG-3); RANK only ever compares ids that already exist. The engine remains pure, dependency-free
and deterministic. *LLMs assist; they never decide.*

### 2. Zero-set semantics (the two cases, decided explicitly)

| Case | Behaviour | Why this option |
| ---- | --------- | --------------- |
| **Job lists NO skills** (absent/empty/all-blank) | The factor is **NOT APPLICABLE**: its .15 weight is **redistributed proportionally** across the other factors (each × `1/(1-0.15)`), so Σ(effective weights) stays **exactly 1.0**. | Chosen because it is **order-neutral with respect to the skills factor**: a job that never opted into skills is not ranked by them. The alternative — scoring the factor 1.0 for everyone — would flatly inflate every such job's score by +0.15 and shift candidates across the `pushEligible` floor. A perfect non-skills match still scores **exactly 1.0** (the ×`1/0.85` arithmetic introduces no float drift). **This does NOT mean skill-less jobs rank as they did pre-ADR-0033 — they do not; see "Behaviour change at deploy" below.** Redistribution neutralizes *this factor*; it cannot undo the ledger's availability/activity cuts, which apply to every job. |
| **Worker has NO confirmed skills** (job HAS requirements) | **0 on the skills factor ONLY.** Never a block, never a penalty on any other factor; the worker still appears in the ranking. | This is a **deliberate, ruling-mandated exception** to ADR-0006's neutral-default rule ("a blank field never drops a worker"). The CEO ledger makes skills a real discriminator; a worker with unknown skills cannot score as if they matched. The cost is bounded and honest: **max −0.15**, sort-only, and the chat can confirm skills later — exactly the "fuller profile ranks higher" principle (§5) the engine already encodes. It is called out here because it is the one place this ADR trims a §3 default. |

### 3. The weight ledger — old → new

The 06-19 lock lists a **full ledger** (Trade 35 · Location 20 · Skills 15 · Experience 15 ·
Salary 10 · Availability 5 = Σ100), so **that table is the target directly** — no proportional
renormalization of the old set was needed or performed:

| Signal | Implemented (pre-ADR-0033) | **CEO lock → shipped now** | Δ |
| ------ | -------------------------- | -------------------------- | - |
| Trade / role | .35 | **.35** | — |
| Location / distance | .20 | **.20** | — |
| **Skills** | **— (no signal; TAX-6 locked it out)** | **.15** | **NEW** |
| Experience | .15 | **.15** | — |
| Pay / salary | .10 | **.10** | — |
| Availability | .10 | **.05** | **−.05** |
| Activity | .10 | **0** | **−.10 (dropped from the score)** |
| **Σ** | **1.00** | **1.00** | ✓ |

Two interpretations the ledger did not spell out — **stated explicitly so the owner can veto
either without re-reading code**:

- **(I1) "Drop Activity" = weight 0, component RETAINED.** The ledger omits Activity entirely and
  the 06-19 note says "drop Activity". We set `activity: 0` rather than deleting the signal: its
  raw is still computed and still surfaces as an explainable component. Reason — it is load-bearing
  elsewhere: it is `rankWorkersForJob`'s **deterministic recency tie-break**, and it is one of
  LEARN's six feature axes. Deleting it would silently change tie-break ordering and break
  `@badabhai/reach-learn`'s feature contract, which is **not** what the ledger asked for.
  Activity contributes **exactly 0 to the score** — the ledger's intent is met. *Veto path: if
  "drop" meant "delete the signal", say so and it is a small follow-up.*
- **(I2) The skills-less-job redistribution** (above) is our choice, not the ledger's — the ledger
  is silent on jobs without skill requirements. It is the stability-preserving option.

### 4. Serving-layer wiring (supply side live; demand side honestly absent)

- **Worker (supply) side — LIVE.** `worker_profiles.skills` (canonical ids, ADR-0030) joins the
  existing `ReachRepository.SIGNAL_COLUMNS` projection — **the same single query, no join, no N+1**
  — and `workerProfileRowToSignals` maps it to `WorkerSignals.skillIds` defensively (non-array /
  garbage / blanks → `[]`). The projection discipline (D8) is unchanged: still **never**
  `embedding` or `raw_profile`. Skill ids are faceless taxonomy tokens, **not PII** — they do not
  enter any response, `feed.shown` payload, or log that did not already carry them.
- **Job (demand) side — NOT WIRED, and this is stated rather than faked.** The serving `jobs`
  entity **has no skill-id column**: the canonicalized `skill_ids` live on the **separate**
  `job_postings` entity (TAX-6, migration 0038), and **there is no join path between the two**
  (the known two-job-entity debt, **TD37**). So every jobs-table job maps to a `JobSpec` **without**
  `skillIds` → the engine redistributes the weight → **the skills factor itself is inert in serving**
  until demand-side ids arrive. Per the brief, no migration is invented here.
  ⚠️ **Inert ≠ no behaviour change.** Because *every* job takes the redistribution path, every job
  is now scored under the ledger's other two changes. See the next section — **this deploy re-ranks
  every live feed.**

### 6. Behaviour change at deploy — MEASURED, not asserted

**This is a behaviour-changing deploy.** An earlier draft of this ADR claimed serving output was
"byte-identical today". **That claim was false and is retracted.** It reasoned about the skills
factor in isolation and ignored that the same ledger cuts **availability .10→.05** and
**activity .10→0** — which apply to **every** job, skill-less ones included. Since the demand side
is unwired, **every live job takes the redistribution path** and is scored under a materially
different effective vector:

| | role | distance | skills | experience | pay | availability | activity |
|---|---|---|---|---|---|---|---|
| **Pre-0033 (live today)** | .35 | .20 | — | .15 | .10 | .10 | .10 |
| **Post-0033, skill-less job (every job today)** | **.4118** | **.2353** | 0 | **.1765** | **.1176** | **.0588** | **0** |

**Measured head-to-head against `main` on skill-less jobs (5000 worker×job pairs):**

- **5000/5000 scores changed** (max |Δ| **0.109538**);
- **413/5000 `pushEligible` flips (8.3%)** — ~1 in 12 workers changes push-notify status;
- **200/200 fleet orders changed.**

Concrete inversion (pinned in the golden regression test): worker **A** (active, mid-availability)
`0.950 → 0.970588` vs worker **B** (available, inactive) `0.920 → 1.000`. **Old winner A; new winner
B.** This is *correct*: activity is not a CEO-ledger signal, so dropping it to 0 is precisely what
the ruling mandates.

**This re-ranking is the intended consequence of the owner's 2026-07-17 ruling, not a side effect.**
The 06-19 ledger mandates the availability/activity changes; shipping the skills factor alone would
leave those two signals still violating the lock — perpetuating exactly the drift row A-2 exists to
close. **The ledger wins.** But the operator deploying this must know: **feeds will visibly reorder
and ~8.3% of workers change push status on the first request after deploy.**

**Made visible, not asserted:** a **golden regression test** (`reach-engine.test.ts`) pins the
old→new scores for a fixed fleet on a skill-less job, records each delta and the order inversion in
a comment, and fails loudly on any future ledger edit. *(Do not read the property test's
skills-factor inertness check as stability evidence — it only proves the skills factor can't move a
skill-less job, which is true by construction. That misreading is what produced the false claim.)*
  → **Follow-up (tracked):** bring demand-side `skill_ids` to the reach projection via an additive
  migration on `jobs` **or** the postings→jobs bridge (TD37). **No index is missing today**
  (nothing is filtered/joined on skills — the ids ride the existing row read); if a future
  demand-side design filters on ids, revisit indexing then.

### 7. The lock test — inverted, not deleted

[`no-skills-in-rank.test.ts`](../../packages/reach-engine/src/no-skills-in-rank.test.ts) is edited
in this same diff (its own instruction), becoming the **inverse lock**. The filename is kept so
every existing reference (ADR-0030, `schema.ts` TAX-6 comments, the drift register) still resolves.
It now asserts:

1. **The `/embedding/i` half is KEPT** (and widened to `cosine|similarity`) over every non-test
   source of **both** `reach-engine` and `apps/api/src/reach`, comment-stripped, and the file walk
   is now **recursive** (a flat `readdirSync` would have let a future
   `apps/api/src/reach/read-model/*.ts` escape a lock that claims to scan *every* non-test source).
   Skills-similarity-by-embedding in RANK still requires its own ADR **and** an edit to this test.
2. **Determinism**: no `Math.random` / `Date.now` / `new Date(` / `fetch(` / `setTimeout` in the
   engine sources — the factor cannot quietly become impure.
3. **The factor exists**: `skillsOverlap` is implemented, `ADR-0033` is cited at the factor site,
   and the **full seven-entry weight ledger is pinned** — any future weight edit fails CI until an
   ADR changes it deliberately.

The `/skill/i` half is necessarily gone: it is exactly what the ruling authorised.

## Consequences

- **The CEO ledger is now the code.** RANK scores skills deterministically at .15. `WEIGHTS` is
  pinned by two tests; changing it requires a new ADR.
- **⚠️ Serving output CHANGES at deploy — every live feed re-ranks.** The *skills factor* is inert
  (demand-side ids absent), but the ledger's availability .10→.05 + activity .10→0 hit every job:
  **5000/5000 scores changed, max |Δ| 0.109538, 8.3% `pushEligible` flips, 200/200 fleet orders
  changed** (§6). Owner-ruled and intended — **not** a low-risk no-op landing.
- **Downstream of the re-ranking, disclosed:**
  - **PACE supply decisions change.** `pace.service.ts` (`countAboveFloorSupply`) counts supply by
    the `hot` flag (top-12% ∧ roleRaw>0). Reordering changes which jobs read as thin-supply →
    different widening waves and ops alerts. **Bounded by `PACE_ENABLED=false` (inert by default)**,
    so nothing fires today — but it is a real coupling, and the retracted "byte-identical" claim
    wrongly implied it could not happen.
  - **`feed.shown` VALUE-regime break for the LEARN corpus.** The payload **schema is unchanged**
    (invariant #8 is fine — no version bump owed), but `rank`/`score` **values** switch regime at
    deploy with **no marker in the stream**, so the offline corpus silently mixes two regimes across
    the deploy boundary. **Feature vectors are safe** (reach-learn recomputes raws from unchanged
    snapshots — see the pinned baseline below); **the exposure is the ingested ordering/labels
    only.** Mitigation for the LEARN follow-up: split the corpus at the deploy timestamp, or add a
    regime marker before training on cross-deploy data.
  - **`pnpm db:verify:reach` check (a)'s distribution shifts** (`verify-reach.ts`) — its published
    seeded-pool numbers are **not** stable across this change; re-baseline them rather than reading
    a diff as a regression.
- **SORT-NEVER-BLOCK holds** — structurally (the factor only contributes to a score; no filter
  exists anywhere on the path) and by property test (`count in == count out` with skills in play).
- **`@badabhai/reach-learn` is deliberately NOT recalibrated.** Its `BASELINE_WEIGHTS` was a spread
  of the engine's live `WEIGHTS`; it is now **pinned to the pre-ADR-0033 six-signal ledger**, so the
  offline learner's baseline/bounds/guardrail — and its published eval — stay bit-identical rather
  than silently changing under it. LEARN remains **offline with no live influence** (ADR-0017), so
  invariant #4 is unaffected. *Follow-up (offline, tracked): recalibrate LEARN onto the ADR-0033
  ledger, incl. the skills raw as a seventh feature axis.*
- **Explainability improved**: `components[]` now carries a `skills` row with a human reason
  ("2/4 required skills matched" / "job lists no skill requirements (weight redistributed)").
  Components carry **effective** weights, so `score == Σ(weight × raw)` holds exactly in both modes
  (property-tested).
- **Contract surface**: `JobSpec.skillIds` / `WorkerSignals.skillIds` are **optional + additive**
  (default `[]`) — every existing caller compiles unchanged. `ReachSignal` gains `"skills"`; the DTO
  `signal` field is a `string`, so no response contract broke. **No event payload changed, no
  schema/migration changed.**
- **No PII**: skill ids are closed-set taxonomy tokens. The faceless boundary, the D8 projection,
  and every `feed.shown` payload are untouched.

## Rollback

**Revert the commit — that is the whole story.** No schema, no migration, no event version, no data
backfill is involved, so there is nothing to undo outside the code:

- `WEIGHTS` returns to the six-signal set (skills gone, availability .10, activity .10);
- the factor, the two optional `skillIds` fields, and the `skills` component disappear (all
  additive/optional — nothing depended on them);
- the repository projection drops `skills` (one column, no join);
- the lock test reverts to its TAX-6 "skills OUT" form.

**Rollback is CHEAP but NOT invisible.** *(An earlier draft called it "behaviourally a no-op today"
— also false, and retracted for the same reason as the deploy claim.)* Reverting restores the
pre-0033 weight vector, so it **re-ranks every live feed a second time**, back to the old order —
the same ~8.3% of workers flip push status back. There is no data to unwind (no schema, migration,
event version, or backfill), so the cost is one deploy and one visible reorder, with **no lasting
trace** beyond the two regime boundaries left in the `feed.shown` history (§6).

**Partial rollback** (keep the factor, restore the old ledger): set `WEIGHTS.skills = 0` — the
redistribution makes the factor inert — **and** restore `availability: 0.10` / `activity: 0.10`.
Setting `skills = 0` **alone is not a rollback**: the availability/activity cuts are what move
today's scores.

## Follow-ups (tracked)

1. **Demand-side `skill_ids` on the reach path** — additive migration on `jobs` or the
   postings→jobs bridge (**TD37**). Until then the factor is inert in serving.
2. **LEARN recalibration** onto the seven-signal ledger (offline; separate human gate per ADR-0017).
3. **Legacy worker skills**: pre-TAX free-text entries in `worker_profiles.skills` simply never match
   a closed-set id (0 on the factor, never a block) until the offline re-tag runner (TAX-9) catches up.
4. **Interpretations I1/I2** above are open to owner veto without re-reading code.

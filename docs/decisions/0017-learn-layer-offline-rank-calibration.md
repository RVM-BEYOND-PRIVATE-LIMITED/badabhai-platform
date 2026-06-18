# ADR-0017: LEARN layer — offline learning-to-rank that calibrates the deterministic RANK core

- **Status:** **ACCEPTED for the OFFLINE build (human-authorized 2026-06-17) — LIVE promotion
  remains a SEPARATE human gate.** The offline layer is **built**: `@badabhai/reach-learn`
  (feature pipeline + baseline model + eval harness + shadow harness, 24 tests green), results in
  [learn-layer-eval-results.md](../reach/learn-layer-eval-results.md). Per Decision 6 **no live
  ranking is touched** — the RANK core (`@badabhai/reach-engine`) is **unchanged**, the layer is
  **off by default**, and **promoting any `WeightProfile` to live ranking is a distinct,
  human-gated decision** (its own sign-off), NOT authorized here.
- **Date:** 2026-06-17
- **Phase:** **Phase-2 moat work — explicitly NOT alpha-gate.** Does not displace or block the
  alpha. The RANK core (ADR-0006) is unchanged; LEARN is purely additive and **off by default**.
- **Author:** system-architect (decision + contract), folding in ai-engineer (model + eval
  methodology), performance-engineer (scale), and security-engineer (feature-set PII review).
- **Relates / builds on:**
  - **ADR-0006 (Reach foundation — deterministic RANK core)** — the six-signal weighted checklist
    (`role .35 · distance .20 · experience .15 · pay .10 · availability .10 · activity .10`),
    "sort-never-block", neutral-default-never-penalize. ADR-0006 **explicitly defers LEARN**
    ("behavioural re-ranking") and names the dials as "fixed in shape but tunable… not learned yet
    (LEARN is Phase 2)." **This ADR is that deferred decision.**
  - **ADR-0005 / ADR-0011 / ADR-0015** — the `worker_profiles → WorkerSignals` projection and the
    live feed surfaces that **emit** `feed.shown` / `application.*`. LEARN **consumes** those events;
    it does not change how they are produced or served.
  - **CLAUDE.md invariant #4** — *LLMs/ML ASSIST; the deterministic Reach Engine DECIDES.* This ADR's
    central constraint: LEARN **tunes weights**; deterministic rules + caps still gate. **No LLM.**
  - **Open-question Q8** (embeddings / model-training tables) — **resolved below**.

---

## Context

The matching algorithm has four conceptual stages — **REACH → RANK → PACE/PROTECT → LEARN**.
RANK is built and deterministic (ADR-0006): it ranks with **zero usage data** on a fixed,
explainable, six-signal checklist, and **never calls a model**. That was deliberate so the product
works on day one. The cost of that choice is that the dial values (`WEIGHTS`, `RankOptions`) are
**hand-set** — nobody has tuned them against what workers and payers actually do.

We now have the raw material to do better: a **PII-free behavioural event stream** that records,
per worker, which jobs were surfaced (`feed.shown`) and what happened (`application.submitted` /
`application.skipped`). LEARN is the classical-ML layer that learns from that stream to **calibrate
the RANK dials** so the feed orders better — **without** the model ever deciding who is shown,
rejected, or matched. That decision stays with the deterministic engine and its caps (invariant #4).

This is **moat work, not alpha work.** It must be **offline-first** (train and evaluate with zero
production influence), **architecture-led** (this ADR before any code), and **safe by construction**
(it can only ever broaden a worker's opportunity surface — "widen, never narrow").

### The hard constraints this design must satisfy

1. **The model never decides.** It emits **bounded adjustments to the existing dials**, consumed by
   the *same* deterministic scoring function. Sort-never-block, neutral-defaults, hot-gating, the
   push floor, and PROTECT caps are untouched and still gate **after** scoring.
2. **No LLM.** LEARN is classical ML (learning-to-rank). LLMs profile/canonicalize; they do not rank.
3. **No raw PII in features.** Features come from the `events` stream and derived 0..1 signals only.
   `worker_id`/`job_id` are opaque UUIDs used as **join/group keys**, never as learned features.
4. **Offline-first, then shadow, then a separate human gate to go live.** No live influence until a
   distinct, signed promotion decision — mirroring the `AI_ENABLE_REAL_CALLS` staging-first pattern.
5. **Widen, never narrow** — encoded as a **measurable guardrail** that *fails the eval* if violated.

---

## Decision

Build — **for sign-off, not yet for implementation** — an **offline learning-to-rank pipeline** over
the PII-free `events` stream whose only output is a **versioned, signed `WeightProfile`** (bounded
calibrations of the six RANK signal weights, optionally segmented by coarse context). The
deterministic engine consumes a `WeightProfile` exactly as it consumes `WEIGHTS`/`RankOptions` today
— same function, same guards. The layer is **off by default**, validated **offline**, then run in
**shadow**, and only ever broadens reach.

```
events (PII-free)  ──►  [1] FEATURE PIPELINE  ──►  [2] MODEL (classical LTR)  ──►  WeightProfile vN
   feed.shown            offline · versioned        learns bounded dial            (signed config
   application.*         derived signals only        calibrations, NOT a            artifact, NOT a
                         (no raw PII, no ids                decision                 DB-resident model)
                          in the feature vector)             │
                                                             ▼
                                          [3] OFFLINE EVAL (held-out, temporal split)
                                          ranking quality (NDCG/MAP/MRR)  AND
                                          ⛨ widen-never-narrow guardrail (gating)
                                                             │  clears?
                                                             ▼
                                          [4] SHADOW (compute + compare, DO NOT serve)
                                                             │  holds up?
                                                             ▼
                                          [5] PROMOTE TO LIVE — SEPARATE HUMAN GATE (not here)
```

### Decision 1 — Model class: classical learning-to-rank, output = bounded dial calibration

**Baseline (recommended first): coordinate-ascent / pairwise-logistic calibration of the six
existing weights**, optimizing offline NDCG@k on held-out impressions. It produces a `WeightProfile`
— six non-negative weights renormalized to sum 1.0 — that drops straight into the existing scoring
function. Why this is the right *baseline*:

- **Maximally interpretable and auditable** — the output is literally "role .35 → .31, activity .10
  → .14"; ops and reviewers can read it. It maps 1:1 onto ADR-0006's dials.
- **Structurally assist-not-decide** — it can only move dial *values* within clamps; it cannot change
  the function shape, zero out a signal, add a filter, or memorize an individual.
- **Works at low data volume** — six parameters need far less data than a tree ensemble; honest for
  an early event stream.

**Documented upgrade (later, same constraints): LambdaMART / gradient-boosted ranker (LightGBM)**
optimizing NDCG, used in one of two **bounded** integration modes (Decision 4) so it still only
*calibrates/augments* the deterministic score, never replaces or gates it. The upgrade is a tuning
change, not a re-architecture, and is **not** authorized by this ADR.

**Explicitly rejected:** any model that (a) is an **LLM**, (b) outputs a **hard accept/reject/hide**,
(c) consumes **raw PII or raw ids** as features, or (d) runs **in the live rank hot path** (would
break determinism + dependency-freedom — ADR-0006). A learned re-rank must remain a *pre-computed,
bounded weight artifact*, never a live model call.

### Decision 2 — Feature pipeline: offline, reproducible, versioned, `events`-only, PII-free

- **Single source: the `events` table** (`feed.shown` impressions, `application.submitted` /
  `application.skipped` outcomes). No worker/PII tables are read for features.
- **Label** (implicit feedback): `application.submitted` → positive; `application.skipped` →
  negative (the enum reason becomes a coarse feature, not a label); `feed.shown` with no action in
  the session window → weak negative (configurable; position-bias-corrected, see eval).
- **Feature vector = the six deterministic signal components** (`role/distance/experience/pay/
  availability/activity` raw 0..1) **+ coarse context** (rank position for position-bias correction,
  `source_surface`, coarse time bucket, coarse trade-family). These are **derived, PII-free signals**
  — the same numbers the engine already computes.
- **`worker_id` / `job_id` are JOIN + LTR-GROUP keys only** — used to assemble `(impression, outcome)`
  rows and to group impressions by query for ranking metrics, then **excluded from the feature
  matrix**. They are **never** one-hot/embedded/learned-on (that would risk per-individual
  memorization and re-identification). A hard pipeline assertion enforces a **fixed feature
  allowlist**; the build **fails** if any column outside the allowlist (or any PII-shaped field)
  enters the matrix.
- **Point-in-time correctness:** to learn over the signal space, each impression needs the six
  component values *as they were when shown*. Recommended (additive, governed): bump **`feed.shown`
  to v2** to carry the six component raws (still PII-free 0..1 signals) via the `event-schema-change`
  skill — **versioned, never mutating v1**. Until v2 data accrues, the pipeline reconstructs
  components deterministically from a point-in-time `WorkerSignals` snapshot. **No event payload is
  mutated; v1 stays valid.**
- **Reproducible + versioned:** every run is pinned by `{event-window, code-version, feature-spec
  hash, random seed}` and emits a dataset manifest. Same inputs → same dataset → same model. The
  pipeline is **offline** (a batch job over a read replica / export), never on a request path.

### Decision 3 — Offline eval: held-out ranking quality **and** the widen-never-narrow guardrail

- **Split: temporal, not random** — train on older events, test on a later held-out window (prevents
  outcome leakage and reflects "predict the future feed"). Report with confidence intervals.
- **Ranking-quality metrics (must improve vs the ADR-0006 baseline weights):** **NDCG@k**, **MAP**,
  **MRR**, all **position-bias-corrected** (inverse-propensity weighting on rank) so the model learns
  relevance, not "people click rank 1." Plus a **calibration** check.
- **The widen-never-narrow guardrail is a GATING metric, not a nicety** (Decision 5). Eval is a
  **PASS only if** ranking quality improves **AND** every widen-never-narrow check holds.

### Decision 4 — How the learned signal feeds RANK **without deciding** (the integration seam)

The engine already exposes the seam: `WEIGHTS` (the six dials) and `RankOptions`. LEARN's artifact is
a **`WeightProfile`** consumed through that seam, additively and **off by default**:

- **Mode A (baseline, recommended): weight calibration.** The `WeightProfile` *replaces the six
  weight values* (renormalized to sum 1.0) for a scoring run. The scoring function, the
  neutral-defaults, and sort-never-block are byte-for-byte unchanged. (Implementation, post-sign-off:
  an optional `RankOptions.weights?: WeightProfile` that **defaults to the const `WEIGHTS`** —
  additive, backward-compatible, no behaviour change when absent.)
- **Mode B (later option): a bounded additive learned term.** A seventh signal with a **capped**
  weight, **floored at the neutral default** so it can only *raise* a worker, never push below
  baseline — never zero out or filter. Deferred; Mode A ships first.

In **both** modes: the model output is a **pre-computed bounded config artifact**, applied
deterministically; **the deterministic rules and caps still run and still gate** (hot-gating on a
real candidate, push floor, PACE/PROTECT caps). The model **never** sees a live request, **never**
emits a per-worker decision, **never** removes anyone from a feed.

**Bounds (safety clamps on every `WeightProfile`):** each weight ∈ `[w_min, w_max]` around its
ADR-0006 value (recommended ±0.10 absolute, tunable), weights renormalize to 1.0, role stays the
dominant signal (`role ≥ max(others)`), and no weight may be driven to 0 (no signal can be
*switched off* by learning). These bounds are config, asserted in code, and part of the artifact's
signed schema.

### Decision 5 — "Widen, never narrow" as a measurable guardrail

The layer **may only broaden a worker's opportunity surface, never restrict it.** Made measurable,
computed offline by replaying ranking with **baseline weights vs the learned `WeightProfile`** over
the held-out window:

1. **Set-monotonicity (structural, asserted):** the set of workers that *appear* for any job is
   **identical** baseline vs learned — LEARN only reorders, never filters. Metric: `dropped_workers
   == 0` for every job. (Guaranteed by Mode A + sort-never-block; asserted as a test, not assumed.)
2. **Per-worker exposure floor (the real guardrail):** for each worker `w`, define
   `exposure(w)` = a rank-discounted appearance weight in top-K feeds over the window. Require
   **`exposure_learned(w) ≥ (1 − ε) · exposure_baseline(w)`** for every worker (recommended
   `ε = 0.05`). **No worker may lose more than ε of their baseline opportunity, and no worker's
   exposure may fall to zero.** The eval **FAILS** if any worker breaches the floor.
3. **Cohort widening (the positive target):** for the cohorts the moat is meant to help —
   **new / sparse-profile / low-activity / cold-start workers** — median and p10 exposure must be
   **≥ baseline** (ideally **up**). LEARN must lift the bottom, not just sharpen the top.
4. **No demographic-proxy narrowing:** monitor exposure deltas across coarse trade-families and
   regions; flag any cohort whose exposure regresses. (Trade/region only — no protected attributes
   exist in the data, by invariant #2.)

The guardrail is reported as a first-class result alongside NDCG/MAP and is a **hard gate** on both
the offline eval and the shadow comparison.

### Decision 6 — Shadow before live (and a separate human gate to promote)

When offline eval clears, run in **SHADOW**: the live feed continues to **serve the deterministic
ranking**; in parallel the system computes the learned ranking and **logs a PII-free comparison**
(rank deltas, NDCG proxy on realized outcomes, the widen-never-narrow guardrail on live traffic) —
recommended via an additive `reach.shadow_ranked` v1 event (ids/positions/metrics only, no PII).
**Shadow serves nothing.** Promotion of a `WeightProfile` to live ranking is a **separate,
human-gated decision** (its own ADR/sign-off), exactly like the real-LLM flip — requiring: a clean
offline eval, a shadow window where quality holds and the guardrail never breaches, and an instant
rollback (drop the `WeightProfile` → revert to const `WEIGHTS`, no deploy).

---

## Q8 — RESOLVED

> **Q8: "Embeddings / model-training tables were frozen into the schema — intended first use and when?"**

**Resolution (2026-06-17, this ADR):**

- **The premise is stale.** There is **no `model_training` table and no standalone `embeddings`
  table** in the current schema (the ADR-0014 Phase-1 foundation does not contain them). The only
  embedding is **`worker_profiles.embedding`** (768-dim Vertex, HNSW cosine index), and per
  **ADR-0006** it serves the **AI profiling / semantic-similarity** path — **explicitly NOT Reach
  ranking.** So "embeddings" ≠ "ranking model."
- **The LEARN layer's first use** is **offline learning-to-rank over the `events` stream to calibrate
  the deterministic RANK dials** (this ADR). It needs **neither** a frozen `model_training` table
  **nor** embeddings: its training data is the PII-free event spine (+ a point-in-time signal
  snapshot), and its artifact is a **versioned `WeightProfile` config file**, not a DB-resident
  model — keeping LEARN **offline-first and DB-light**.
- **If** a model/artifact registry is ever wanted (e.g. `reach_models`: version, metrics, status,
  created_at — **no PII**), it is an **additive Phase-2 migration** decided then, **not** the
  "frozen" table Q8 imagined. A Skills-relevance signal using **pre-computed** embeddings + a
  deterministic cosine (ADR-0006 follow-up) remains a separate, later decision.

→ **Q8 moves to Resolved**, pointing here. (Embeddings = profiling, not ranking; LEARN's first use =
event-driven dial calibration; no frozen ML tables required.)

---

## Gate review (folded in, per the task) — design-level only; re-run on the built artifacts

### bb-architecture-review
- **In phase scope?** Phase-2, correctly gated; does not displace alpha. ✅ (with sign-off STOP).
- **Event-first?** Consumes the governed `events` contract; the only new producers are *additive,
  versioned* (`feed.shown` v2, optional `reach.shadow_ranked` v1) via the `event-schema-change`
  skill — no v1 payload mutated (invariant 8). ✅
- **AI privacy boundary?** No LLM on the path; no PII toward any model (Decision 2). ✅
- **Repo/service split + determinism?** The engine stays pure/deterministic; LEARN is an **offline**
  batch + a **bounded config artifact** consumed through the existing dial seam — **no live model
  call in the rank path**. ✅
- **Contract/version impact + rollback?** Additive only; rollback = drop the `WeightProfile`. ✅
- **ADR-worthy?** Yes — new seam + new offline subsystem; hence this ADR. **Decision unresolved until
  human sign-off (STOP).**

### bb-scalability-analysis (performance-engineer lens)
- **Hot path unaffected:** ranking stays O(workers) pure arithmetic; applying a `WeightProfile` is
  six multiplies — **zero added latency**, no model call, no I/O. ✅
- **Training is offline/batch** over a read replica or export; it never contends with serving. Event
  volume is the audit spine (bounded, append-only); a temporal-windowed batch scales linearly and
  runs on a schedule, not per request.
- **Cold-start honesty:** at low event volume the baseline six-parameter model is appropriate; the
  GBDT upgrade waits for volume. No premature scale-out.
- **Single-region / Supabase fit:** read-replica/export for training; no new live datastore; the
  `WeightProfile` is a small signed file. No new bottleneck on the AI service or DB hot path. ✅

### bb-security-review (security-engineer lens — the feature set)
- **No raw PII in features** — `events` are PII-free by invariant #2; the feature matrix is a **fixed
  allowlist** of derived 0..1 signals + coarse context; a pipeline assertion **fails closed** if any
  non-allowlisted/PII-shaped column appears. ✅ (gate: must be a test on the built pipeline.)
- **No re-identification via ids** — `worker_id`/`job_id` are join/group keys only, excluded from the
  vector; no per-individual learned parameters. ✅
- **No new PII surface** — artifacts are weights + aggregate metrics; shadow events carry ids/
  positions/metrics only. ✅
- **Fairness/widen guardrail** doubles as a safety control against systemic narrowing (Decision 5).
- **Required before any build:** a security review of the **realized** feature spec + the no-PII
  pipeline test (this review is design-level; it does not clear the implementation).

---

## EXPLICITLY OUT — hard boundary (do not drift)

- **No change to live ranking** — the engine, its weights, and its served output are untouched by
  this ADR. LEARN is off by default; turning it on live is a *separate* human-gated ADR.
- **No LLM** anywhere on the ranking path.
- **No hard filtering / accept-reject / hide** by the model — sort-never-block is inviolable.
- **No raw PII or raw ids as features**; no live model call in the rank hot path.
- **No PACE / PROTECT / agency-attribution** redesign — out of scope.
- **No promotion to live** — offline + shadow only; promotion is its own signed decision.

---

## STOP — sign-off required before ANY implementation

**This is a design artifact. Nothing here is built or authorized.** Before a line of pipeline/model/
eval/shadow code:

1. **Human/RVM sign-off on the six decisions above** — especially the model class (Decision 1), the
   integration seam + bounds (Decision 4), and the widen-never-narrow ε/cohort thresholds (Decision 5).
2. Then the streams hand off: **backend-engineer** (feature pipeline over `events`), **ai-engineer**
   (baseline model + eval harness + methodology), **performance-engineer** (batch scale), with
   **security-engineer** reviewing the realized feature set + the no-PII pipeline test.
3. **Shadow is a checkpoint, not a launch.** Going live is a separate signed decision (Decision 6).

**Do not proceed past this line without recorded human sign-off.**

---

## Related

- ADR-0006 (deterministic RANK core + the dials this calibrates; defers LEARN — this is that decision)
- ADR-0005 / ADR-0011 / ADR-0015 (the `WorkerSignals` projection + feed surfaces that emit the events)
- `packages/reach-engine/src/{scoring,ranking,types}.ts` (the `WEIGHTS`/`RankOptions` seam)
- `packages/event-schema/src/{payloads,registry}.ts` (`feed.shown`, `application.*` — the labels)
- CLAUDE.md invariant #4 (ML assists; the deterministic engine decides); §7 (escalate: new seam → ADR)
- Open-question **Q8** (resolved here)

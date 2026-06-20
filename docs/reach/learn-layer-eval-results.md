# LEARN layer — offline eval results + shadow plan (ADR-0017)

> **Status:** OFFLINE results from `@badabhai/reach-learn` (built 2026-06-17). **No live
> ranking is influenced.** The RANK core (`@badabhai/reach-engine`) is **unchanged** —
> this package only *computes* (dataset → model → eval → shadow). Promotion to live is a
> **separate human-gated decision** (ADR-0017 Decision 6).
>
> **Data caveat (honest):** the real `events` stream currently has **0** `feed.shown` /
> `application.*` rows (the feed surface hasn't run at volume — verified 2026-06-17). These
> results are from a **deterministic, PII-free synthetic harness** (`fixtures/synthetic.ts`)
> with a KNOWN planted preference, used to validate the *methodology + safety gates*. They
> are **not** a production-quality claim — re-run on real events before any promotion.

## What was built

| Stage | Module | Guarantee |
| ----- | ------ | --------- |
| Feature pipeline | [`features.ts`](../../packages/reach-learn/src/features.ts) · [`dataset.ts`](../../packages/reach-learn/src/dataset.ts) | `events`-only, reproducible, **PII fail-closed** (denylist on keys/values; fixed feature **allowlist** = the 6 signal raws; ids are join keys, never features) |
| Model | [`model.ts`](../../packages/reach-learn/src/model.ts) | bounded coordinate-ascent calibration of the 6 weights (±0.10, role-dominant, no zeroing, Σ=1); validation-selected; **deterministic**; widen-never-narrow enforced as an optimizer constraint |
| Eval | [`metrics.ts`](../../packages/reach-learn/src/metrics.ts) · [`eval.ts`](../../packages/reach-learn/src/eval.ts) | held-out temporal split; NDCG@k / MAP / MRR (IPW position-bias corrected); **gated PASS** = quality not regressed AND guardrail holds |
| Guardrail | [`guardrail.ts`](../../packages/reach-learn/src/guardrail.ts) | **measured** widen-never-narrow (per-worker exposure floor, no-zero, cold-cohort widening, set-monotonicity) |
| Shadow | [`shadow.ts`](../../packages/reach-learn/src/shadow.ts) | compute + compare, **serves nothing** (`servedLive: false`); emits PII-free `reach.shadow_ranked` shape (not wired) |

## Offline eval results (synthetic harness, NDCG@10, IPW-corrected, held-out 30% temporal test)

Dataset (seed 21): 900 rows → 630 train / 270 test, 27 query-feeds. Calibrated weights:
`role .35→.425 · distance .20→.177 · experience .15→.133 · pay .10→.089 · availability .10→.089 · activity .10→.089` (every move within ±0.10; role stays dominant; nothing zeroed).

| seed | NDCG@10 base→learned (Δ) | MAP Δ | MRR Δ | guardrail | min exposure ratio | cold-cohort Δ | eval.pass |
| ---- | ------------------------ | ----- | ----- | --------- | ------------------ | ------------- | --------- |
| 21 | 0.8065 → 0.8067 (**+0.0002**) | +0.0000 | +0.0000 | ✅ pass | 0.952 | **+0.046** | ✅ |
| 1 | 0.7559 → 0.7539 (**−0.0021**) | −0.0054 | 0.0000 | ✅ pass | 0.941 | +0.082 | ⛔ **rejected** |
| 2 | 0.7828 → 0.7850 (**+0.0022**) | +0.0043 | +0.0185 | ✅ pass | 0.914 | +0.018 | ✅ |
| 3 | 0.8158 → 0.8265 (**+0.0107**) | +0.0139 | +0.0062 | ✅ pass | 0.929 | **+0.139** | ✅ |
| 101 | 0.8245 → 0.8245 (+0.0000) | 0.0000 | 0.0000 | ✅ pass | 0.936 | +0.055 | ✅ |

### How to read this (the honest story)
- **Widen-never-narrow HOLDS on every seed** — min per-worker exposure ratio ≥ 0.91 (floor 0.90), **no worker zeroed**, set-monotonic, and the **cold/sparse cohort exposure Δ is positive on every seed** — the layer measurably *widens* the bottom, never narrows.
- **Gains are small but SAFE.** The guardrail *binds*: a candidate that chases the planted `pay` signal would bury high-expectation workers, so the optimizer rejects it and instead leans on `role` (the legitimate dominant signal). Safe, modest lift (up to **+0.0107 NDCG@10**) beats an unsafe larger one — by design (invariant #4 + Decision 5).
- **The gate REJECTS seed 1** (held-out NDCG −0.0021) → `eval.pass=false`. The eval is a **real gate**, not a rubber stamp; only profiles that don't regress AND don't narrow would ever reach shadow.
- **The learner provably works:** with the guardrail OFF (demonstration only, never promotable) the calibrator recovers the planted `pay` signal — confirming the modest constrained gains are the guardrail holding it back, not a broken learner.

Every number is **reproducible** — same seed → byte-identical dataset/profile/eval (asserted in `reproducibility.test.ts`), measured across 5 independent seeds (not one cherry-picked run).

## Tests (24, all green)
`features` (PII fail-closed + allowlist) · `dataset` (events-only, temporal, deterministic, PII-refusing) · `model` (bounds, role-dominant, no-zero, deterministic) · `metrics`/`eval` (NDCG/MAP/MRR sanity, gated pass, learner recovers signal, guardrail binds) · `guardrail` (passes no-op, **detects narrowing**, cold-cohort reporting) · `reproducibility` (byte-identical across runs; safety holds + gate sound + majority-improve across 5 seeds; shadow never serves).

## Shadow plan (before any live promotion — Decision 6)
1. Wire the producer: bump `feed.shown` → **v2** (additive, PII-free) to carry the 6 component raws, so features are exact (no snapshot reconstruction). Accrue real `feed.shown`/`application.*` volume.
2. Re-run this offline eval on **real** held-out events; a profile must clear the gate (quality ≥ baseline AND guardrail pass).
3. **Shadow:** compute the learned ranking alongside the served deterministic ranking; log the PII-free `reach.shadow_ranked` comparison (`computeShadow` / `buildShadowEvents`). **Serve nothing.** Watch a window: quality holds on realized outcomes AND the guardrail never breaches.
4. **Promote = separate human gate** (its own sign-off). Integration is additive + off by default (an optional `RankOptions.weights` defaulting to the const `WEIGHTS`); **instant rollback** = drop the `WeightProfile`, no deploy. The RANK core stays untouched until that gate.

## Cross-links
[ADR-0017](../decisions/0017-learn-layer-offline-rank-calibration.md) · [ADR-0006](../decisions/0006-reach-foundation-rank-core.md) (the dials this calibrates) · [`@badabhai/reach-learn`](../../packages/reach-learn) · [`@badabhai/reach-engine`](../../packages/reach-engine) (untouched).

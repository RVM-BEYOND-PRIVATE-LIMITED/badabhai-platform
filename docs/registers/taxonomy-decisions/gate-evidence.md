# The promotion gates, and exactly what would turn each one green

**Prepared against main `cc8ef65b` · measured 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · no gate weakened, no baseline moved, nothing waived**

Reproduce: `pnpm db:audit:gate-evidence --batch <dir> --json=<out>`
Artifact: [`gate-evidence.json`](./gate-evidence.json) · Tests: `gate-evidence.test.ts` (22)

> **STATUS: COMPLETE. One structural defect found and repaired; the remaining blockers are
> named, attributed and costed.** Two need AI spend (₹0.028 total). One needs an owner or a
> corpus fix. **Promotion remains blocked.**

---

## Why the gates' own output was never actionable

`judgeRegression` returns the **first** reason it refuses and stops. There are several, they
fire in a fixed order, and fixing the visible one reveals the next. *"`NO_REGRESSION` FAIL
96/96"* has been true for weeks and told nobody what to do.

This audit does not *describe* the blockers — it **derives** them. It reads every experiment
record on disk, runs the runner's own `judgeRegression` and `bestCorrectScores` against each with
the live corpus fingerprint, and reports why each specific artifact cannot clear the gate.
`REGRESSION_BASELINE` and `CANONICALIZATION_FLOOR` are imported, never re-declared, so this
report cannot disagree with the runner about where the bar is.

---

## The structural defect, and the repair

`promote-skills` computes:

```ts
no_regression: regression.passed && !sweepStale
```

`sweepStale` reads `sweepRecord.corpus_fingerprint`. **`ExperimentRecord` had no such field**, and
`taxonomy-floor-sweep.ts` is the only producer of sweep records. So every sweep was **stale on
arrival**, and no re-run could change that: `NO_REGRESSION` was **unsatisfiable by construction**,
independent of any regression.

**Repair:** `corpus_fingerprint?: CorpusFingerprint | null` added to `ExperimentRecord`
(optional — old records must stay readable), and the floor sweep now stamps it, read *after* the
queries so it describes the corpus the run actually saw, and recorded as `null` on failure rather
than fabricated.

> **This is not a relaxation, and the tests say so.** A stale sweep still fails. A record with no
> fingerprint still cannot prove currency. `REGRESSION_BASELINE` is still 1.0 / 1.0 on evaluator
> v2 / fixture v2, `CANONICALIZATION_FLOOR` is still 0.75, and `CRITERIA` is still the closed
> seven — each asserted. What changed is that a gate which could never be satisfied now can be.

---

## NO_REGRESSION — every artifact that exists, judged

| fixture | R@1 | MRR | fingerprint | verdict |
|---|---:|---:|:--:|---|
| v1 | 0.9912 | 0.9956 | no | evaluator v1 ≠ v2 |
| **v2** | **1.0000** | **1.0000** | **no** | **STALE — no fingerprint** |
| v2 | 0.9912 | 0.9956 | no | STALE — no fingerprint |
| v2 | 1.0000 | *null* | no | no MRR to compare |
| v3 | 0.9545 | 0.9751 | no | fixture v3 ≠ v2 |
| v3 | 0.9675 | 0.9816 | no | fixture v3 ≠ v2 |

**An evaluation scoring exactly 1.0 / 1.0 on fixture v2 already exists** — it is the baseline's
own source, `EXP-EVAL-CORRECTION`, 2026-08-17. So the gate is not blocked on an unreachable
score. It was reached once, *before* Gate B embedded the shipped catalogue.

**Not one record of any kind carries a `corpus_fingerprint`** — not the six evaluations, not the
three sweeps. That is the blocker the gate never gets far enough to report.

### The green path

| # | actor | what |
|---|---|---|
| **1** | **ENGINEERING** | the sweep record must be able to carry a fingerprint — **done in this change**; no sweep has been re-run since, so every record on disk is still unfingerprinted |
| **2** | **AI SPEND** | re-run `db:sweep:floor --run --experiment` **and** `db:eval:taxonomy --run --experiment` on fixture **v2**, so both carry a fingerprint matching live |
| **3** | **OWNER or CORPUS FIX** | the fresh v2 evaluation must reach R@1 ≥ 1.0 and MRR ≥ 1.0 |

**Step 2's exact cost**, from the recorded estimates of the identical runs: evaluation
**₹0.014159** (164 queries) + floor sweep **₹0.013969** (164 queries) = **₹0.028128**. Neither can
be produced from stored vectors — both embed *query* text, which the corpus does not contain.
**Not spent. Not authorized.**

**Step 3 is the honest one.** The last v2 run scored **0.9912**, and that is a *real* regression:
Gate B embedded the shipped catalogue, which put `skill_turning` (5 aliases, previously
unembedded) into competition inside `jd_nco_7223_6002` and cost case GP-04. A fresh v2 run is
expected to reproduce it. So step 3 needs a corpus fix or a recorded waiver —

> **and a waiver cannot substitute for step 2.** Freshness is explicitly not waivable: *"A human
> may waive a measured REGRESSION — that is a reviewed judgement about a real number. Nobody may
> waive the question of whether the number is about this corpus at all."*

---

## RESOLVABLE_ABOVE_FLOOR — 34 failures, two distinct causes

```
PASSES                        62
CORRECT_BUT_BELOW_FLOOR       28   <- found, correct, not confidently
NO_CORRECT_CASE_IN_SWEEP       6   <- never asked about
ONLY_EVER_A_WRONG_ANSWER       0   <- the worst category is EMPTY
```

62 + 34 = 96, which reconciles the two conventions the documents use: **project-control's
"62/96" is a PASS count** and the runner's "34" is a fail count. Both were right and they read
as contradicting each other.

**The empty category is the good news.** Not one promotable skill appears solely as somebody
else's wrong answer — none has demonstrated it can be confidently mis-assigned while never
demonstrating it can be found.

### The 28: a corpus problem, not a threshold problem

Every one resolves to the **right** skill and does not clear 0.75. Worst is
`skill_wiring_harness_routing` at **0.5986**; the closest are `skill_thermostat_and_control_wiring`
0.7466 and `skill_sub_assembly_quality_checking` 0.7443.

The remedy is more or better aliases. **Lowering the floor is prohibited and would be the wrong
fix anyway** — §5a showed two of three negative ceilings already sit above 0.75, so a lower floor
buys these 28 by admitting known misassignments. Ratifying new aliases is an owner act (TAX-0
gate d), so engineering can propose and cannot land them.

### The 6: an instrument question, not a coverage one

`skill_battery_capacity_checking`, `skill_switchgear_installation`,
`skill_sheet_metal_marking_and_layout`, `skill_indoor_unit_servicing_and_cleaning`,
`skill_pump_and_valve_repair`, `skill_welding_machine_consumable_changeover`.

All six **are** present in fixture v3. The 2026-08-21 sweep scored 164 of v3's 168 cases and
produced no *correct* case for these six. Whether that is retrieval or the run is not yet known,
and **the fresh sweep of step 2 answers it at no additional cost** — it is the same run.

---

## EVAL_COVERED — already green, and the docs quote the wrong fixture

| fixture | cases | promotable NOT covered |
|---|---:|---:|
| `retrieval-v2.jsonl` | 127 | **41** |
| `retrieval-v3.jsonl` | 168 | **0** |

The gate is judged against `--fixture`, whose default is **v3**. A document quoting *"EVAL_COVERED
FAIL 41/96"* is quoting v2 — the superseded fixture. **Under the fixture actually in use the gate
is green, and 41 was never a fail count against 96 in the first place** (41 uncovered *of* 96).

**So no fixture needs authoring, and none was.** This matters more than the number: D6-1 holds
that agent-authored paraphrases must never silently become ground truth, and *"a gate says 41 are
uncovered"* is exactly the pressure that produces them. The gate does not require any.

---

## The four gates that were already green

`GATE_ACCEPTED`, `IS_PROVISIONAL`, `ACTIVE_EDGE`, `FULLY_EMBEDDED` — 96/96 each, unchanged.
`MATCH_VOCABULARY` is green at 0/96 missing since Q1 was ratified.

---

## Summary: who is blocking what

| gate | blocked by | who clears it |
|---|---|---|
| `NO_REGRESSION` | no fingerprinted evidence | **AI spend ₹0.028** |
| `NO_REGRESSION` | 0.9912 < 1.0 (GP-04) | **owner waiver or corpus fix** |
| `RESOLVABLE_ABOVE_FLOOR` | 28 correct-but-low | **corpus work + owner ratification** |
| `RESOLVABLE_ABOVE_FLOOR` | 6 unmeasured | **the same fresh sweep** |
| `EVAL_COVERED` | — | **already green under v3** |
| everything else | — | already green |

**No engineering-only path to promotion exists.** Every remaining blocker needs spend, owner
action, or both — which is a different statement from "blocked", and it is the one that lets
someone plan.

## Gates

```
GATE_ACCEPTED             PASS — 96/96
IS_PROVISIONAL            PASS — 96/96
ACTIVE_EDGE               PASS — 96/96
FULLY_EMBEDDED            PASS — 96/96
MATCH_VOCABULARY          PASS — 0 of 96 missing a disposition
EVAL_COVERED              PASS — 0 of 96 uncovered under retrieval-v3
RESOLVABLE_ABOVE_FLOOR    FAIL — 34 of 96 blocked (62 pass)
NO_REGRESSION             FAIL — 96 of 96 blocked
PROMOTION CANDIDATES      96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED.**

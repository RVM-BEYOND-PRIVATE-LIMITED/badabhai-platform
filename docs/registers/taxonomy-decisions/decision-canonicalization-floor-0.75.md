# DECISION RECORD — the 0.75 canonicalization floor

**STATUS: OWNER DECISION REQUIRED**
**Measured 2026-08-21 · `EXP-P9-TRAINER-V3` floor sweep · fixture v3 · 164 scoring queries**

Nothing in this document changes the floor, the evaluator, or any gate. It records what the
floor actually does to real worker language, so the decision can be made on numbers.

---

## What the floor is

`CANONICALIZATION_FLOOR = 0.75` (`packages/db/src/promote-skills.ts:133`), mirroring
`skill_canonicalize_floor` in the ai-service. A phrase whose best match scores below it
resolves to **UNRESOLVED** — the skill is not assigned at all.

It also gates promotion: `RESOLVABLE_ABOVE_FLOOR` requires a candidate skill to have
demonstrated at least one CORRECT resolution at or above 0.75.

Gate C previously re-measured it and recommended keeping it, on the grounds that 0.75 already
yields 100% precision.

## What it does on this corpus

```
floor = 0.75
TP = 109   FP = 0   FN = 38   TN = 17
precision = 100%   recall = 74.2%   assigned = 66.5%
```

**Precision is perfect. Recall is 74.2%.** At the production floor, roughly **one correct
resolution in four is discarded** — not mis-assigned, silently dropped.

### The distributions overlap

```
separable = false
TRUE-POSITIVE  top-1 scores   n=147  min=0.5986  p50=0.8128  p95=1.0  max=1.0
FALSE-POSITIVE top-1 scores   n=17   min=0.5065  p50=0.5981  p95=0.7216  max=0.7216

lowest correct  = 0.5986
highest wrong   = 0.7216
```

**No threshold separates correct from incorrect on this corpus.** Any floor that admits the
lowest correct answer also admits the highest wrong one. This is the central finding: the floor
is not mis-set, it is being asked to do something the score distribution cannot support.

### The full sweep

| threshold | TP | FP | FN | TN | precision | recall | assigned |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.50 | 147 | 17 | 0 | 0 | 89.6% | 100.0% | 100.0% |
| 0.55 | 147 | 14 | 0 | 3 | 91.3% | 100.0% | 98.2% |
| 0.60 | 146 | 8 | 1 | 9 | 94.8% | 99.3% | 93.9% |
| **0.65** | 141 | 7 | 6 | 10 | **95.3%** | **95.9%** | 90.2% |
| 0.70 | 126 | 3 | 21 | 14 | 97.7% | 85.7% | 78.7% |
| 0.72 | 119 | 2 | 28 | 15 | 98.4% | 81.0% | 73.8% |
| **0.75** | 109 | 0 | 38 | 17 | **100.0%** | **74.2%** | 66.5% | ← **CURRENT** |
| 0.80 | 79 | 0 | 68 | 17 | 100.0% | 53.7% | 48.2% |
| 0.90 | 57 | 0 | 90 | 17 | 100.0% | 38.8% | 34.8% |

**0.65 is an OBSERVATION, not a proposal and not an approved setting.** It is listed because a
decision needs the shape of the trade-off, not one alternative dressed up as a recommendation.
Moving to it would trade 100% precision for ~95.3%, i.e. it would start making *wrong*
assignments where today it makes *none*.

## Why the fixture flattered the floor

The floor was calibrated against a fixture with a large **exact-alias** component — queries that
are literally an alias of the expected skill, which score ~1.0 because they ask the index
whether a string matches itself.

| | exact-alias share |
|---|---:|
| fixture v2 (calibration era) | **44.7%** |
| fixture v3 (with the trainer pack) | **33.5%** |

Real worker paraphrases sit far lower. From the sweep, the lowest-scoring **correct** answers —
the ones the floor discards first — are all trainer phrases:

| score | skill | phrase type |
|---:|---|---|
| 0.5986 | `skill_wiring_harness_routing` | devanagari paraphrase |
| 0.6139 | `skill_pipe_support_and_clamping` | latin paraphrase |
| 0.6313 | `skill_suspension_and_steering_repair` | latin paraphrase |
| 0.6395 | `skill_insulation_resistance_testing` | latin paraphrase |
| 0.6399 | `skill_concrete_curing` | devanagari paraphrase |
| 0.6419 | `skill_electrical_fault_finding` | latin paraphrase |
| 0.6515 | `skill_electrical_safety_and_lockout` | devanagari paraphrase |
| 0.6639 | `skill_non_destructive_testing_of_castings` | latin paraphrase |

**Concretely:** a worker saying *"tracing why the light is not coming using a tester"* resolves
**correctly** to `skill_electrical_fault_finding` at 0.6419 — and is then thrown away as
UNRESOLVED, because 0.6419 < 0.75.

That is the production consequence, and it was invisible while the instrument was mostly
echoes of the corpus.

## Three decisions this is NOT

Keeping these apart matters, because they have been conflated:

| | |
|---|---|
| **threshold decision** | how confident must a match be before we assign it — a precision/recall trade-off, and a product call about whether a wrong skill is worse than no skill |
| **taxonomy coverage decision** | how many occupations have skill edges (28 of 3,885) — orthogonal; more coverage does not raise any score |
| **skill promotion decision** | whether the 96 candidates become `active` — gated on `RESOLVABLE_ABOVE_FLOOR` and `NO_REGRESSION`, both currently FAIL |

Lowering the floor **would** move `RESOLVABLE_ABOVE_FLOOR` from 62/96 toward passing. That is
precisely why it must not be decided as an engineering convenience: it would unblock a gate by
changing what the gate means.

## Effect on `RESOLVABLE_ABOVE_FLOOR` today

Over the 96 promotion candidates at 0.75: **62 pass · 28 resolve correctly but below floor ·
6 never resolve correctly.**

The 28 are not broken skills. They are skills whose only evidence of findability comes from real
paraphrases, which score in the 0.60–0.75 band.

## Options — presented, not chosen

| option | effect | cost |
|---|---|---|
| **Keep 0.75** | zero false assignments; ~26% of correct resolutions silently dropped; `RESOLVABLE_ABOVE_FLOOR` stays failing for 34 of 96 | status quo |
| **Lower the floor** | more resolutions assigned; first wrong assignments appear; unblocks a gate by redefining it | needs owner approval; needs a false-assignment tolerance to be stated |
| **Improve the scores** | add alias coverage so paraphrases land nearer their skill; raises TP scores without touching the threshold | authoring work; the only option that improves the *system* rather than the *cut-off* |
| **Two-stage retrieval** | exact/normalized lookup before the ANN, so paraphrase scores stop being the only signal | design work; `skill_alias.text_norm` already exists for this and is unpopulated on all 106 legacy-domain rows |

**The engineering view, offered as input and not as a decision:** the third and fourth options
are the only ones that make the system more correct. Lowering the floor makes the dashboard
greener while making assignments worse; keeping it makes the product quieter than it should be.
Which of those is acceptable is a product judgement about whether a wrong skill on a worker's
profile is worse than a missing one.

## Caveat on these numbers

The sweep ran **before** TP-36 and TP-19 were rewritten (`613ac8ca`). Both appear in its
false-positive list, so a re-run would shift roughly TP 109→111 and FP 17→15. The qualitative
findings — non-separability, and a large FN population at 0.75 — are unaffected, because those
are driven by the 38 below-floor correct answers, not by those two cases. A refreshed sweep
costs ~₹0.014 and has not been run, to avoid spending without a reason.

## What is needed to close this

A stated tolerance for false assignment. Everything else follows from the table above.

**Owner decision required. No change has been made.**

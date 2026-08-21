# DECISION RECORD — `NO_REGRESSION` and the fixture-version conflict

**STATUS: OWNER DECISION REQUIRED**
**Measured 2026-08-21 · `EXP-P9-TRAINER-V3` · fixture v3 · 164 scoring queries**

Nothing here changes the gate, the baseline, or the thresholds. This records *why* v3 cannot
satisfy `NO_REGRESSION`, and lays out the architectural options without choosing one.

---

## The gate as it stands

`REGRESSION_BASELINE` (`packages/db/src/promote-skills.ts:157`):

```ts
recall_at_1:       1.0
mrr:               1.0
evaluator_version: 2
fixture_version:   2
source:            "EXP-EVAL-CORRECTION eval-taxonomy-retrieval-v1-v2-e2-2026-08-17T06:33:38.652Z"
```

`judgeRegression` rejects in this order: evaluator version → **fixture version** → presence of
metrics → corpus freshness → score comparison.

## v3 fails twice, independently

### Failure A — fixture version, rejected before any score is read

```
baseline.fixture_version = 2
candidate.fixture_version = 3
```

`judgeRegression` returns early: *"evaluation used fixture v3 but the reference is v2"*. The
scores are never compared. **This failure is structural and would occur even at a perfect 1.0.**

### Failure B — the scores, independently

```ts
passed = r.recall_at_1 >= 1.0 && r.mrr >= 1.0   // "No epsilon: an allowance is a number nobody chose."
```

```
observed recall@1 = 0.9675   (baseline 1.0)
observed MRR      = 0.9816   (baseline 1.0)
```

Fails on both. Even if the version check were satisfied, the gate would still refuse.

**Both must be resolved. Fixing either alone changes nothing.**

## Why v3 scores lower — and why that is not a regression

v3 is v2's 127 cases **unchanged** plus 41 reviewed paraphrases. The 5 remaining misses are:

| case | nature |
|---|---|
| TP-27, TP-08, TP-01, TP-15 | genuine sibling ambiguity — real, and worth keeping as evidence |
| GP-04 | pre-existing v2 case, not from the trainer pack |

Every v2 case still passes. `recall@3 = 1.0` and `recall@5 = 1.0` in every category and every
domain — retrieval never *loses* the skill, it mis-orders siblings in 5 of 154 positive cases.

**The instrument got harder. The system did not get worse.** That is precisely the situation
the current gate cannot express, because it compares one number against one number and has no
concept of "which cases".

## The architectural question

> Should regression testing continue against the immutable v2 fixture while v3 is used for
> expanded coverage and retrieval-quality evaluation?

### Option A — keep strict semantics, change nothing

| | |
|---|---|
| changes | nothing |
| does not change | anything |
| safety | maximal — no regression can hide |
| can regressions hide? | no |
| owner approval | not required |
| consequence | promotion stays blocked indefinitely; the 41 trainer phrases can never contribute to a passing gate, so `EVAL_COVERED` and `NO_REGRESSION` are permanently in tension |

Honest and inert. It makes the trainer pack unusable for its stated purpose.

### Option B — split regression from coverage

```
v2 cases  →  REGRESSION set   →  "did existing behaviour get worse?"   (must stay 1.0/1.0)
v3 cases  →  COVERAGE set     →  "does it handle broader language?"    (reported, not gated)
```

| | |
|---|---|
| changes | `NO_REGRESSION` reads the v2 subset of whatever fixture is supplied |
| does not change | the 1.0/1.0 bar, the evaluator, the floor, `EVAL_COVERED` |
| safety | v2 cases still cannot regress; new cases are measured but not gating |
| **can regressions hide?** | **yes, in one specific way** — a change that only harms paraphrase cases would show in the coverage number and not block promotion. That is the real cost of this option and it should not be glossed |
| owner approval | **required** — it changes what the gate means |

This is the option the existing architecture most nearly anticipates: v1 is already described
as *"the immutable instrument of the Phase 5 baseline… never edited"*, and v2 as its versioned
successor. The pattern of a stable instrument plus a growing one is already in the repository.

### Option C — explicit fixture-version migration

Establish a procedure: when a fixture version supersedes another, re-measure and re-point the
baseline with a recorded reason and a named approver.

| | |
|---|---|
| changes | adds a migration ritual; `REGRESSION_BASELINE` gains provenance |
| does not change | the strict comparison itself |
| safety | depends entirely on the discipline of the ritual |
| can regressions hide? | **yes** — if the re-measured value is simply whatever the new run produced, this is threshold-tuning with paperwork |
| owner approval | required per migration |

**The risk is that this legitimises re-pointing.** It only works if the migration requires the
new fixture to *also* score 1.0, which on current evidence it does not.

### Option D — versioned baseline with explicit approval

Keep one baseline per fixture version; each entry needs owner sign-off.

| | |
|---|---|
| changes | `REGRESSION_BASELINE` becomes a map keyed by fixture version |
| does not change | strictness within a version |
| safety | comparable to C, with a clearer audit trail |
| can regressions hide? | across a version boundary, yes — two versions are not comparable by construction |
| owner approval | required per version |

## What the evidence supports

**Option B is the only one that resolves the tension without weakening what the gate currently
proves**, because the v2 cases keep their 1.0/1.0 bar untouched and continue to answer exactly
the question they answer today.

Its cost must be stated plainly: **a paraphrase-only regression would stop being blocking.**
Whether that is acceptable depends on whether paraphrase handling is considered production
behaviour yet. Today it is not — canonicalization is off and no worker phrase reaches
retrieval — but it will be the moment Phase 10 activates, and at that point the coverage set
should become gating too.

**This is a recommendation on the evidence, not a decision. No option has been implemented.**

## What must not happen

Recorded because each is individually tempting and each would be wrong:

- Re-pointing `REGRESSION_BASELINE` to `recall_at_1: 0.9675` — tuning the judgement to fit the
  measurement.
- Setting `fixture_version: 3` on the existing baseline without re-measuring — asserting a
  comparison that was never made.
- Adding an epsilon — *"an allowance is a number nobody chose"*.
- Dropping the 5 failing cases from v3 — deleting evidence.
- Quietly evaluating against v2 while claiming v3 coverage — using two instruments and
  reporting one.

## Current state, unchanged

```
NO_REGRESSION            FAIL   (fixture v3 ≠ v2; and 0.9675 < 1.0)
RESOLVABLE_ABOVE_FLOOR   FAIL   (62 of 96 above the 0.75 floor)
PROMOTION CANDIDATES     0
```

Correct under the current contract. Left exactly as measured.

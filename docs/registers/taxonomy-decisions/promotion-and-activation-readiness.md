# Promotion and activation readiness

**Prepared against main `77f946f8` · 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · nothing promoted, nothing activated, no flag changed**

Sequence: `packages/db/src/activation-sequence.ts` · Graph:
[`programme-graph.md`](./programme-graph.md) · Gates: [`gate-evidence.md`](./gate-evidence.md)
Tests: `activation-sequence.test.ts` (21)

> **Nothing is promoted. Nothing is activated. `SKILL_CANONICALIZE_ENABLED` was not read, set or
> changed by this work.** The sequence below is nine typed rows with a validator; there is no
> runner in the file, no database handle, and a test asserts all three by reading its own source.

---

## Part 1 — Promotion readiness

### Every gate, and exactly what is in the way

| gate | result | why | who clears it |
|---|---|---|---|
| `GATE_ACCEPTED` | **PASS 96/96** | in the ratified batch | — |
| `IS_PROVISIONAL` | **PASS 96/96** | none promoted | — |
| `ACTIVE_EDGE` | **PASS 96/96** | every candidate has a live `job_domain_skill` edge | — |
| `FULLY_EMBEDDED` | **PASS 96/96** | every alias carries a vector, one model | — |
| `MATCH_VOCABULARY` | **PASS 0/96 missing** | Q1 ratified: 5 mapped, 91 explicitly unmatched | — |
| `EVAL_COVERED` | **PASS 0/96 uncovered** | under `retrieval-v3`, the fixture in use. The "41/96" in older docs is `retrieval-v2` | — |
| `RESOLVABLE_ABOVE_FLOOR` | **FAIL 34/96** | 28 resolve **correctly** below 0.75; 6 produced no correct case in the 2026-08-21 sweep | **owner** (aliases) + **₹0** (same fresh sweep) |
| `NO_REGRESSION` | **FAIL 96/96** | no evidence of any kind carries a `corpus_fingerprint` | **₹0.028128** then **owner** |

**Five of eight were already green. A sixth turned out to be green and had been quoted from the
superseded fixture.** The remaining two are the ones the programme has always named, and their
reasons are now specific enough to act on.

### `NO_REGRESSION` — four blockers, of which only two survive

The gate reports the **first** reason it refuses and stops, which is why *"FAIL 96/96"* has been
true for weeks and told nobody what to do. Derived in full:

1. ~~fixture version~~ — **an evaluation scoring exactly 1.0/1.0 on fixture v2 already exists.**
   It is the baseline's own source, `EXP-EVAL-CORRECTION`, 2026-08-17.
2. ~~score~~ — reached once, before Gate B embedded the shipped catalogue.
3. **freshness** — not one record of any kind carries a `corpus_fingerprint`. Six evaluations,
   three sweeps, zero. **Not waivable.**
4. **structural** — `ExperimentRecord` had no such field, while `promote-skills` already computed
   `no_regression = regression.passed && !sweepStale`. **The gate was unsatisfiable by
   construction.** Fixed 2026-08-26; a stale sweep still fails and the 1.0/1.0 bar is untouched.

What remains: a fresh fingerprinted pair (**₹0.028128**), and then the honest problem — the last
v2 run scored **0.9912**, a real regression attributed to case GP-04. A fresh run is expected to
reproduce it, so step 3 of the plan needs a corpus fix or a recorded waiver. **A waiver cannot
substitute for the spend**: freshness is explicitly not waivable.

### `RESOLVABLE_ABOVE_FLOOR` — one gate name, two different problems

```
PASSES                        62
CORRECT_BUT_BELOW_FLOOR       28    found, correct, not confidently (worst 0.5986)
NO_CORRECT_CASE_IN_SWEEP       6    never asked about — but they ARE in fixture v3
ONLY_EVER_A_WRONG_ANSWER       0    the worst category is EMPTY
```

62 + 34 = 96, which reconciles the two conventions the documents use — *"62/96"* is a **pass**
count and the runner's 34 is a **fail** count. Both were right and they read as contradicting
each other.

**The empty category is the good news:** not one promotable skill appears solely as somebody
else's wrong answer.

The 28 need corpus work. **Lowering the floor is prohibited and would be the wrong fix anyway** —
§5a showed two of three negative ceilings already sit above 0.75, so a lower floor buys these 28
by admitting known misassignments. The 6 are answered by the same fresh sweep at no extra cost.

### Can engineering clear any of it alone?

**No.** A test asserts it: no path to `PROMOTION` or `CANONICALIZATION` is engineering-only.
Finishing every executable task in the repository moves neither leaf. `EXECUTABLE` is **0**.

---

## Part 2 — The activation sequence

**Read the ordering as load-bearing.** Two of the nine are ordered for reasons that are not
obvious, and both are asserted by test.

| # | step | authorisation | ready? |
|---|---|---|:--:|
| 1 | **Read the deployed flag** on the box | owner | ✅ |
| 2 | **Rule** on D-7A, D-7C-1a, D-7C-1b, §5a-2, `NO_REGRESSION` semantics | owner | ✅ |
| 3 | Apply the ratified **alias de-elections** | production write | ⛔ |
| 4 | **Seed** the three approved deprecations | production write | ⛔ |
| 5 | **Fresh fingerprinted** sweep + evaluation | ₹0.028128 | ⛔ |
| 6 | Clear `RESOLVABLE_ABOVE_FLOOR` | owner | ⛔ |
| 7 | **Promote** the 96 | production write | ⛔ |
| 8 | **Observe with canonicalization still OFF** | none | ✅ |
| 9 | **Enable `SKILL_CANONICALIZE_ENABLED`** — *this is the activation* | owner | ⛔ |

**The sequence stops at step 3.** Steps 1, 2 and 8 are ready — they decide or observe. **Nothing
that writes is ready.**

### Why the flag is read first

Every severity assessment in the register is a function of a value nobody has read. The secret
exists, its value was **changed on 2026-08-24 11:30:45 UTC**, and the deploy job runs on every
push to `main` — so the change is live. §5a's three above-floor misassignments are severe exactly
in proportion to that value. Reading it costs one command and can only shrink the problem or
reframe it.

### Why the spend comes after the corpus writes and after the ruling

- **After the writes**, so the fingerprint describes the corpus that will actually be promoted
  rather than the one before it. Measuring first would produce a record that is stale on arrival
  — precisely the defect that made the gate unsatisfiable.
- **After the ruling**, because the `NO_REGRESSION` semantics decision chooses which fixture to
  measure. Spending first buys the wrong measurement.

### Why observation sits between promotion and the flag

Promotion widens the retrieval surface — 96 skills become visible to it — and that is measurable
**before** anything routes to it. A ceiling that rises above its pre-promotion value is a reason
to stop, not a reason to continue carefully.

### Every production write names both halves

| step | verification | rollback |
|---|---|---|
| alias de-elections | `db:audit:alias-cleanup` → residue 0 | delete the JSON entry, re-run `db:embed:skills`; row, id and text were never deleted |
| D-7C seed | the runner reads every row back; the crosswalk matrix flips CORPUS-ONLY → LIVE | status + pointer flip back; nothing is deleted |
| promotion | audit report written; 96 provisional → active | `status='provisional'` for the batch's 96 ids |

The validator refuses a production-write step with no rollback, and refuses any step whose runner
contains `--apply` while claiming to need no authorisation.

**The enable step is honest that its rollback is partial:** setting the secret back takes one
deploy cycle, and *rows already written are not unwritten by it*. `worker_skill` would need a
separate, reviewed deletion.

---

## What is NOT in this plan, deliberately

- **No date.** Every step is gated on a person, and putting a date on someone else's decision
  manufactures a commitment nobody made.
- **No partial promotion.** `promote-skills` is fail-closed by design: nothing is promoted unless
  every candidate clears every non-waived criterion. *"It did most of them"* is not a state
  anyone can reason about later.
- **No waiver.** `--waive` exists and is legitimate; using it here would be an agent deciding a
  reviewed judgement belongs to a human.

## Where the loop stopped, and why

Every task that could be finished with repository changes, tests, read-only measurement,
dry-runs, audits, tripwires or documentation **has been**. What remains is eleven owner
decisions, one infrastructure fact, three unauthorised production writes and ₹0.028 of
unauthorised spend — and none of them is something an agent may decide.

## Gates

```
GATE_ACCEPTED · IS_PROVISIONAL · ACTIVE_EDGE · FULLY_EMBEDDED    PASS — 96/96
MATCH_VOCABULARY                                                 PASS — 0 of 96 missing
EVAL_COVERED                                                     PASS — 0 of 96 uncovered (retrieval-v3)
RESOLVABLE_ABOVE_FLOOR                                           FAIL — 34 of 96 (62 pass)
NO_REGRESSION                                                    FAIL — 96 of 96
PROMOTION CANDIDATES                                             96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED · NOTHING ACTIVATED.**

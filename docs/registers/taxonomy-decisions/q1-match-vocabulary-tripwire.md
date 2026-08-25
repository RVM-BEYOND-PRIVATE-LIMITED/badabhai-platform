# Q1 — the match-vocabulary tripwire

**Prepared against main `55cf203c` · 2026-08-25 · repository-only, no database**
**Production mutation: NONE · AI spend: ₹0 · no mapping generated, no decision invented**

> **OWNER DECISION 1 — RATIFIED (2026-08-25).** Every promotable skill must carry an explicit
> disposition, `MATCHED` or `INTENTIONALLY_UNMATCHED`, and promotion must be impossible when a
> skill has neither. The disposition names below are the owner's. The owner further directed:
> *do not blindly map all 96*, *do not create new `mskill_*` concepts merely to make the 96
> pass*, and concentrate review effort on the subset that can plausibly map to the existing
> vocabulary — the remainder may legitimately become `INTENTIONALLY_UNMATCHED`.
>
> This document is the gate. **Filling in the 96 dispositions is a separate, following task**;
> none is decided here.

Reproduce: `pnpm db:audit:match-vocabulary --json=<out>`
Artifact: [`q1-match-vocabulary-coverage.json`](./q1-match-vocabulary-coverage.json)

---

## 1. The hole

`ATTRIBUTE_TO_MATCH_SKILLS` is the only bridge from an extracted attribute skill to a
posting-level `mskill_*`. A test in `@badabhai/taxonomy` asserts that bridge is **exhaustive**,
which reads like full protection and is not — **its universe is `SKILL_CORPUS`**, the 49
hand-authored seeds.

A skill that never entered `SKILL_CORPUS` is not *unmapped and failing*. It is **outside the
question the test asks**. So a growth batch could promote to `active`, become visible to
canonicalization and retrieval, reach nothing at match time, and **no test anywhere would
fail**.

**MEASURED** — the two universes do not overlap at all:

| | |
|---|---:|
| promotable batch (`accepted-skills.jsonl`) | **96** |
| `SKILL_CORPUS` | 49 |
| promotable skills also in `SKILL_CORPUS` | **0** |
| bridge keys | 49 |
| match vocabulary | 18 `mskill_*` |

The exhaustiveness test therefore asks its question of **none of the 96**.

---

## 2. The distinction the tripwire is built on

"Reaches no match skill" is **two** states, and collapsing them is what made the gap invisible:

| state | in the bridge | verdict |
|---|---|---|
| `MISSING_DECISION` | **no key** — nobody triaged it | **FAILS** |
| `INTENTIONALLY_UNMATCHED` | key present, value `[]` | **passes** |
| `MATCHED` | key present, every target a real `mskill_*` | passes |
| `INVALID_TARGET` | mapped to an `mskill_*` that does not exist | **FAILS** |

At runtime the first two reach exactly the same thing: nothing. At review time they are
opposites — one is an unanswered question, the other is an answer. This reuses the bridge's own
idiom (*"THE EMPTY ONES ARE THE POINT"*) rather than inventing a second register for the same
fact, so there is one place to look.

`INVALID_TARGET` is separated from `MATCHED` because *having a mapping* and *having a mapping
that resolves* are different claims. A typo in a match-skill id would otherwise read as full
coverage while reaching nothing — the same silent-nothing failure, one level down.

---

## 3. Current state

```
promotable skills (universe) = 96
mapped                          0
intentionally not matched       0
MISSING a decision             96   <- blocks promotion
mapped to an UNKNOWN mskill     0

TRIPWIRE = FAIL   (96 blocking)
```

**This is evidence, not a defect introduced here.** The 96 have never had the question asked of
them. The tripwire's contribution is that the question is now asked, at the point where it
matters, and cannot be skipped silently.

---

## 4. Where it runs, and why it is not a criterion

Promotion has a **closed set of seven criteria**, pinned by a test that records a deliberate
decision to fold new invariants into existing composites rather than grow the set. Nothing here
belongs inside an existing composite: coverage is a property of **the batch being promoted**,
not of one skill's readiness. Growing the set would also have meant reinterpreting a gate.

So the tripwire is a **batch-level precondition**, the same shape as the existing `--sweep` and
`--eval` artifact requirements — it runs in `promote-skills` immediately after the batch scope
is resolved:

- **PLAN** — reported, not enforced. Plan mode exists so an operator can see the whole gate
  report and learn what to fix; throwing there would hide the other seven criteria behind this
  one and make the tripwire *harder* to act on.
- **APPLY** — **refuses.** Nothing is written.

**It is not waivable**, and that is structural rather than conventional: `vocabularyTripwireError`
takes no waiver set. Every other criterion answers *"is this skill ready?"*, and a human who has
reviewed the evidence may reasonably override one. This one answers *"has anyone decided what
this skill MEANS at match time?"* — and there is no version of *"I have reviewed the missing
decision"* that is not simply making the decision.

The verdict is also recorded in the promotion report artifact (`match_vocabulary`), because
*"did every promoted skill have a match-vocabulary decision?"* is exactly the question a later
reader of that report cannot otherwise answer.

---

## 5. What this task did NOT do

**No mapping was generated and no decision was invented.** `decisions_generated: 0`,
`mappings_proposed: 0`, asserted by test.

- `ATTRIBUTE_TO_MATCH_SKILLS` — still exactly its 49 `SKILL_CORPUS` keys; **none of the 96 was
  added.** A test asserts each blocking id is still absent.
- `MATCH_SKILLS` — still 18. Not expanded.
- The closed criteria set — still seven, in the same order.
- Nothing promoted. `eligible = 0`, unchanged.

**Pending decisions left pending**, asserted by test where assertable: `skill_boring` (D-7A),
`skill_chassis_fitting` (D-7B), `skill_dimensional_inspection` (D-7C-1), selective three-skill
seeding (D-7C-2), `SKILL_CANONICALIZE_ENABLED` deployed state, vernacular §5a, the 0.75 floor,
`NO_REGRESSION`, the regression baseline.

> **The tripwire is deliberately not a reason to fill the 96.** Which of the two decisions a
> skill deserves is a product judgement owned by the bridge owner; mapping eagerly is how an
> unrelated worker reaches a specialist vacancy. The instrument refuses to guess, and says so
> in its own refusal message.

---

## 6. Verification posture

Repository-only. The report reads committed files and code — **no database, no provider, no
credentials** — so it is immune to the intermittent pooler and reproduces identically from a
clean checkout. A test re-derives the coverage from source and compares it to the committed
artifact, so a stale hand-edited artifact fails.

The one database-touching check (that the precondition is wired into `promote-skills` and that
the gate state is unchanged) was run as a **PLAN**, which writes nothing.

## 7. Gates

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL — 96/96      unchanged
EVAL_COVERED              FAIL — 41/96      unchanged
PROMOTION CANDIDATES      96, eligible 0    unchanged
MATCH_VOCABULARY          FAIL — 96/96      NEW (this task)
```

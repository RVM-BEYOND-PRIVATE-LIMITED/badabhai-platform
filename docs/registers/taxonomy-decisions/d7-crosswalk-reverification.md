# D-7 — the crosswalk surface, re-verified whole

**Prepared against main `e653a544` · measured 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · no ruling changed, no crosswalk written**

Reproduce: `pnpm db:audit:crosswalk-invariants --json=<out>`
Artifact: [`d7-crosswalk-invariants.json`](./d7-crosswalk-invariants.json) · Tests:
`crosswalk-invariants.test.ts` (23)

> **STATUS: VERIFIED. Six crosswalks, two widening, both ruled. Zero unruled widening.**
> One misassignment that no ruling covers, and it is not a crosswalk defect.

---

## Why a second crosswalk instrument

`audit-crosswalk-chain` narrates **one** subject in five hops, and it is the right tool for
deciding a case — D-7A and D-7B were both settled by reading it. What it cannot answer is *"is
anything else like this"*, because it must be pointed at a skill by name. **Every crosswalk
defect in this programme was found by someone happening to look.**

This asks the same four questions of every crosswalk in **both** places the programme keeps one:

| set | predicate | who acts on it |
|---|---|---|
| **LIVE** | `skill.replaced_by IS NOT NULL` | `db:retag:skills`, today |
| **CORPUS** | `SKILL_CORPUS[].replacedBy` | a seed, if one runs |

Neither contains the other, and the difference **is** the D-7C question. Auditing only the live
set would report that the D-7C deprecations are not a crosswalk problem — because they are not
a crosswalk yet.

---

## The matrix

```
subject                          successor                    src         status      wide retag hop0->succ  elsewhere
skill_boring                     skill_turning                CORPUS-ONLY active      YES  no            0        1   [RULED]
skill_cad_interpretation         skill_drawing_reading        CORPUS-ONLY active      no   no            0        0
skill_chassis_fitting            skill_mechanical_assembly    LIVE        deprecated  YES  YES           1        0   [RULED]
skill_dimensional_inspection     skill_quality_control        CORPUS-ONLY active      no   no            1        2
skill_gdt_reading                skill_drawing_reading        CORPUS-ONLY active      no   no            0        0
skill_go_no_go_gauge_checking    skill_measuring_instruments  LIVE        deprecated  no   YES           2        0
```

**widening 2 · unruled widening 0 · live 2 · corpus-only 4**

---

## What each column is asking

**WIDE** — does the successor's bridge entry imply a match claim the subject's does not? Then
re-tagging *invents* a claim. **Semantic replacement is not matching equivalence**, and only a
human can say whether a given one is intended.

**RETAG** — would `db:retag:skills` move stored references today? Only the live set.

**HOP0→SUCC** — does the subject's own phrase *already* land on the successor, above the floor,
with no retag at all? Retrieval never reads `replaced_by`; it filters `s.status = 'active'`.
Where this is non-zero, **forbidding the retag runner contains nothing** — the claim is live.

**ELSEWHERE** — does the phrase land above the floor on a skill that is **not** the successor?
That is a misassignment the crosswalk does not describe, and it is how D-7A was found.

---

## The four verifications this task owed

### 1. `skill_chassis_fitting` — unchanged, and now reads as ruled

Live, deprecated, widening (`+mskill_fitter`), retag-eligible, and HOP-0 already routes
`chassis assembly` onto the successor in **3 canonical domains at 0.757**. It is the **only**
crosswalk that is both live and widening — asserted by test.

The behaviour is exactly what D-7 recorded on 2026-08-24. What changed is that it now carries
**D-7B, RATIFIED 2026-08-26** in the matrix itself. Without that, the row says
`WIDENING=TRUE LIVE` forever — true, and reading as an open defect. **A ruling is information;
dropping it loses the fact that somebody looked.**

### 2. `skill_boring` — contained, and deliberately still visible

| check | result |
|---|---|
| present in the matrix | **true** — absence would be indistinguishable from a filter bug |
| source | CORPUS-ONLY → `db:retag:skills` cannot touch it |
| retag-eligible | **false** |
| in the D-7C seed set | **false** |
| still widening on paper | **true** (`+mskill_cnc_turner`) |
| HOP-0 | `boring` → `skill_drilling` **0.7556**, not `skill_turning` |

**Containment is asserted positively, not as an absence.** The 0.7556 figure reproduces D-7A
exactly, from a third independent instrument (after the chain audit and the §5a sweep) — the
three agree.

### 3. `skill_dimensional_inspection` — the one finding no ruling covers

Not widening. Bridge-neutral. And its phrase lands on **`skill_drawing_reading` @ 0.7570 in two
canonical domains**, which is not its successor.

> **Neutral-on-the-bridge and safe-in-retrieval are different properties.** The bridge says
> these three invent no match claim; one of them still puts a phrase on the wrong skill above
> the floor. A test asserts both halves of that sentence about the same skill, so the
> distinction cannot collapse back into "D-7C is neutral, therefore D-7C is safe".

D-7C-1 established that the alias cleanup does not fix this — it relocates the landing to
`skill_gdt_reading` at the identical score. Per-label resolution does reach it.

### 4. Replacement semantics and bridge behaviour

`skill_go_no_go_gauge_checking` is the contrast case that makes the rule legible: **live,
retag-eligible, and widening nothing**, because `skill_measuring_instruments` maps to `[]`. A
live crosswalk is not automatically a hazard — the bridge decides. HOP-0 still moves 9 domains
onto the successor at 0.7933, so *coverage* moves and no *claim* is gained. Those are different
things, and the matrix keeps them in different columns.

The bridge is **code, not data** (HOP 3). A test re-reads `ATTRIBUTE_TO_MATCH_SKILLS` and
asserts every `bridge_successor` in the artifact matches it, so the audit cannot drift from the
constant the runtime uses.

---

## What this adds that the per-subject audit could not

`unruled_widening_count` is now a **number with a test on it**. A seventh crosswalk added
tomorrow — in the corpus or in production — appears in the matrix, and if it widens without a
ruling the count goes to 1 and the suite fails. The failure mode this closes is not a wrong
answer; it is **a question nobody asked**.

---

## What did NOT change

No ruling was altered, created or withdrawn. D-7A stays **HELD**, D-7B stays **RATIFIED**, D-7C
stays approved-in-principle and blocked on D-7C-1a. `SKILL_CANONICALIZE_ENABLED` (false) · the
0.75 floor · `NO_REGRESSION` · the baseline · `MATCH_SKILLS` · the bridge · every alias, vector
and status · promotion.

## Gates

```
MATCH_VOCABULARY          PASS — 0 of 96 missing a disposition
RESOLVABLE_ABOVE_FLOOR    FAIL — 34 of 96 blocked
NO_REGRESSION             FAIL — 96 of 96 blocked
EVAL_COVERED              PASS under fixture v3
PROMOTION CANDIDATES      96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED.**

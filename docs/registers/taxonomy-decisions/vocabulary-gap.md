# The match-vocabulary gap — and the constraint upstream of it

**Prepared against main `960393ec` · measured 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · no `mskill_*` invented, `MATCH_SKILLS` still 18**

Reproduce: `pnpm db:audit:vocabulary-gap --json=<out>`
Artifact: [`vocabulary-gap.json`](./vocabulary-gap.json) · Tests: `vocabulary-gap.test.ts` (16)

> **ANSWER: NO new `mskill_*` vocabulary is required.** Not "not yet" and not "arguably" —
> **a new concept for any unrepresented family could not be required by any job the platform is
> able to accept.**

---

## The question, and why the obvious answer is wrong

Q1 left 91 of 96 promotable skills `INTENTIONALLY_UNMATCHED`, 62 of them in the eight trade
families the triage recorded as unrepresented. The obvious reading: the match vocabulary is too
small and needs eight more concepts.

A match skill only ever does anything **when a job requires it**. Jobs carry a `trade_key`, and
`TRADE_KEYS` is a **closed 15-value union** — the Phase-1 alpha trades — validated on the posting
path. `TRADE_TO_MATCH_SKILL` is **total** over it (asserted by test).

So the reachable demand surface is not "whatever employers need". It is exactly the image of 15
trade keys under one total function:

```
TRADE_KEYS                       15
distinct mskills they reach       7
MATCH_SKILLS defined             18
mskills NO job can ever require  11
```

**The vocabulary is wider than the demand surface, not narrower.** Eleven concepts —
`mskill_mig_welder`, `mskill_tig_welder`, `mskill_arc_welder`, `mskill_plumber`,
`mskill_carpenter`, `mskill_cnc_turner`, `mskill_hmc_operator`, `mskill_cam_programmer`,
`mskill_cnc_grinding_operator`, `mskill_interior_designer`, `mskill_delivery_rider` — cannot be
required by anything today. Not dead: **unreachable**, which is a statement about the *trade*
taxonomy, not the match one.

`mskill_battery_technician` would join them the day it was created.

---

## The two sides, kept apart

The first version of this analysis judged "needs new vocabulary" from the **attribute bridge**
and reported `assembly` as a gap — while `assembly_technician` was already routed to
`mskill_fitter`. Those are different questions and they had one column:

| | asks |
|---|---|
| **attribute side** | do this family's promotable skills carry a bridge mapping? |
| **demand side** | do this family's trade keys reach an `mskill_*`? |

Only the second decides whether vocabulary is missing. A test pins the distinction against the
exact `assembly` case that produced the mistake.

```
family               skills matched unmatched  trades  attribute side              demand side
electrical               11       0        11       0  -                           -            <- no job postable
warehouse                11       0        11       0  -                           -            <- no job postable
hvac                     10       0        10       0  -                           -            <- no job postable
welding-support          10       0        10       0  -                           -            <- no job postable
masonry                   9       0         9       0  -                           -            <- no job postable
auto-service              7       0         7       0  -                           -            <- no job postable
plumbing                  7       3         4       0  mskill_plumber              -            <- no job postable
quality                   7       2         5       1  mskill_quality_inspector    mskill_quality_inspector
battery                   6       0         6       0  -                           -            <- no job postable
mech-maintenance          6       0         6       2  -                           mskill_fitter
assembly                  4       0         4       1  -                           mskill_fitter
machining-support         4       0         4      11  -                           5 CNC/design mskills
sheet-metal               4       0         4       0  -                           -            <- no job postable
```

**9 of 13 families have promotable supply and no postable demand, covering 75 skills.**
`plumbing` is the sharpest illustration: three of its skills *are* mapped to `mskill_plumber`,
and no job can require `mskill_plumber`, because no `trade_key` says plumber. The mapping is
correct and inert.

**Every family that can receive a posting already reaches a match skill.** So
`newVocabularyRequired` returns **empty**, and it is judged on the demand side so that stays true
for the right reason.

---

## Live demand, and the fact that none of it is connected

All 19 jobs (17 open) route cleanly:

| trade | jobs | applications | → match skill |
|---|---:|---:|---|
| `vmc_operator` | 3 | 3 | `mskill_vmc_operator` |
| `cnc_operator` | 2 | 4 | `mskill_cnc_operator_general` |
| `vmc_programmer` | 2 | 2 | `mskill_cnc_programmer` |
| `autocad_draftsman` · `cad_designer` · `solidworks_designer` | 3 | 6 | `mskill_designer` |
| `assembly_technician` · `fitter` · `maintenance_technician` | 3 | 4 | `mskill_fitter` |
| `machine_operator` · `production_engineer` · `tool_room_technician` · `cnc_programmer` · `cnc_vmc_setter` | 5 | 8 | CNC family |
| `quality_inspector` | 1 | 1 | `mskill_quality_inspector` |

**Trade keys on live jobs with no match skill: 0.**

And the chain that would consult any of it is empty:

```
job_posting_skill   0
worker_skill        0
job_reach           0
```

A match skill is consulted when a **posting requires it** and a **worker carries it**. Both sides
are zero, so the vocabulary gap **costs nothing measurable today** — and would cost something the
moment steps 4 and 6 of the relevance chain are connected.

---

## What this means for promotion

Promoting the 96 makes them **visible to canonicalization and retrieval** and **invisible to
matching**, which is exactly what Q1 ratified. That is not a defect introduced by promotion; it
is the corpus describing supply the platform cannot yet express demand for.

**The prior decision is the trade taxonomy.** Expanding `TRADE_KEYS` beyond the 15 Phase-1 alpha
trades is a product decision about scope — and until it happens, adding `mskill_*` concepts would
satisfy the Q1 tripwire and be consulted by nothing. **Vocabulary that reads as progress and
changes nothing** is worse than an honest empty mapping, because the next reader believes the
family is served.

> **No owner decision is opened here.** The question asked — *is new `mskill_*` vocabulary
> required* — has a measured answer of **no**, and the decision it defers to (`TRADE_KEYS` scope)
> already exists as Phase-1 alpha scope. Recording a new decision would be manufacturing one.

## Caveat on method

`TRADE_KEYS_BY_FAMILY` — which trade keys belong to which triage family — is an **analytical
placement by the audit author, not a ratified mapping**. It affects which families are reported
as having postable demand and nothing else; no runtime path reads it, and a test asserts the
artifact says so. All 15 keys are placed, so a 16th cannot arrive unattributed.

## What did NOT change

`MATCH_SKILLS` 18 · `ATTRIBUTE_TO_MATCH_SKILLS` 145 keys · `TRADE_KEYS` 15 ·
`TRADE_TO_MATCH_SKILL` unchanged · `SKILL_CANONICALIZE_ENABLED` false · the 0.75 floor ·
promotion status.

## Gates

```
MATCH_VOCABULARY          PASS — 0 of 96 missing a disposition
EVAL_COVERED              PASS — 0 of 96 uncovered under retrieval-v3
RESOLVABLE_ABOVE_FLOOR    FAIL — 34 of 96 blocked
NO_REGRESSION             FAIL — 96 of 96 blocked
PROMOTION CANDIDATES      96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED.**

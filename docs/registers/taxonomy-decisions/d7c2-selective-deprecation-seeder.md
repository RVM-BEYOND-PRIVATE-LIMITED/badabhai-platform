# D-7C-2 — the selective guarded deprecation seeder

**Prepared against main `e653a544` · planned 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · the runner exists and has never written**

Runner: `pnpm db:seed:deprecations --only=<ids>` · rules: `packages/db/src/deprecation-seed-plan.ts`
Tests: `deprecation-seed-plan.test.ts` (26)

> **STATUS: BUILT, TESTED, AND CORRECTLY REFUSING.** It does not stop for want of authorisation.
> It stops on **OWNER DECISION D-7C-1a**, which it detects on its own.

---

## Why a new runner rather than a flag on `db:seed:skills`

`db:seed:skills` lands the **whole corpus** — 165 skill upserts plus every corpus and wedge
alias. To use it for three status changes you must also accept all of that, and on production it
needs `--preserve-existing-status`, whose entire purpose is to **stop** it changing statuses. So
the stock seeder can change all four drifting statuses or none.

D-7C's three-vs-four split *is* the decision. `skill_boring` is held under D-7A; the other three
are approved. A runner whose blast radius is "the three skills you named" is a different runner
from one whose blast radius is "the corpus", and it gets its own name, its own
`OPS_ALLOW_PRODUCTION` token and its own review.

**What it writes, exhaustively:**

```sql
UPDATE skill SET status = 'deprecated', replaced_by = $2, updated_at = now()
 WHERE skill_id = $1
```

Status and pointer move in **one** statement: the CHECK is `replaced_by IS NULL OR status =
'deprecated'` and evaluates the whole new tuple, so writing the pointer first violates it and
writing the status first leaves a window with no successor. `version` is deliberately untouched
— `db:seed:skills` does not write it either, and bumping it here would be this runner inventing
a lifecycle semantic no decision record establishes. It never inserts, never deletes, never
touches `skill_alias`, and never embeds. Asserted by reading its own source.

---

## Boring cannot get in, by three independent routes

| route | what stops it |
|---|---|
| named directly | `D7C_SEED_EXCLUSIONS` — refused, quoting the 0.7556 measurement |
| named alongside approved skills | the **whole set** is refused, not trimmed |
| arriving via the corpus | the scope is an allow-list in code; the corpus marks **four** rows deprecated and the allow-list holds **three** |

The third is the one that matters over time. The corpus is not where the D-7A hold lives, so a
runner that derives its scope from `status === "deprecated"` re-includes boring the first time
anyone re-runs it — no code change, no test failure. A test asserts the corpus's deprecated set
is exactly one larger than the allow-list, so adding a fifth corpus deprecation fails until
someone rules on it.

**Refusal is whole-set, never per row.** Trimming the forbidden id and applying the rest leaves
the operator believing the run did what they asked.

---

## What it refuses on today

```
requested     = skill_gdt_reading, skill_cad_interpretation, skill_dimensional_inspection

vocabulary the seed retires (expected): 3 phrase(s)
  dimensional inspection, inspection, quality check
cross-decision orphans (refuses):      2

REFUSED — 2 precondition(s) failed:
  x the phrase "gd&t" would SURVIVE this deprecation, and does not: a separate ratified
    election removes the other holder, so retrieval keeps neither.
  x the phrase "geometric dimensioning and tolerancing" — same.
```

### The distinction the first version of this check got wrong

The first implementation refused on **five** phrases, and three of them were simply what the
owner approved. Deprecating a skill takes its own phrases out of retrieval — that is what a
deprecation *is*, HOP-0 already quantifies it, and a runner that refuses on it can never run at
all. So the impact is split:

| | meaning | verdict |
|---|---|---|
| **coverage loss** | the only live holder is a subject of this seed | **reported** |
| **cross-decision orphan** | the phrase *would have survived*, and does not, because a **separate** ratified decision removes the other holder | **refuses** |

Only the second is a defect, and it is exactly the D-7C-1a conflict: the 2026-08-21 elections
hand `GD&T` and `geometric dimensioning and tolerancing` to `skill_gdt_reading`, and this seed
deprecates `skill_gdt_reading`. Both ratified, each safe alone, neither file mentioning the
other.

Two details that make the check hard to slip past:

- It reads **live rows**, not either file's beliefs. Nothing in the repository connects the two
  decisions, so no static check could find this.
- A **ratified-but-unapplied** election counts as applied. The end state is identical whichever
  write happens first, so a check that only saw applied writes could be defeated by ordering.

---

## The mechanism does work — the conflict is one member

Drop `skill_gdt_reading` and the same runner produces a clean plan:

```
requested     = skill_cad_interpretation, skill_dimensional_inspection
cross-decision orphans (refuses):      0
preconditions PASS. 2 row(s) would change:
  skill_cad_interpretation      active -> deprecated   replaced_by NULL -> skill_drawing_reading
  skill_dimensional_inspection  active -> deprecated   replaced_by NULL -> skill_quality_control
```

**This subset is not proposed.** Seeding two of three approved deprecations because the third is
blocked would be the agent choosing a scope, and the scope is the decision. It is shown to
establish that the blocker is D-7C-1a and nothing else.

---

## Every precondition, and why each exists

| refusal | why it is not merely defensive |
|---|---|
| `--only` is required | a deprecation seed that picks its own scope is the D-7A failure |
| id outside the allow-list | widening the set is an owner decision, not a command-line argument |
| id in `D7C_SEED_EXCLUSIONS` | the D-7A hold, quoted with its measurement |
| id named twice | a duplicated id is a mistake in the request; deduplicating hides it |
| corpus status ≠ `deprecated` | the corpus is the source of the deprecation, not the flag |
| corpus carries no successor | retirement-without-successor is legal and is a **different decision** |
| subject missing on target | there is nothing to deprecate |
| successor missing on target | the self-FK would fail — better to say why |
| successor not `active` | this would silently create a deprecation **chain** |
| cross-decision orphan | D-7C-1a |

---

## Safety posture

- **Dry run is the default.** `--apply` gates both the ops guard's `mutating` flag and the
  `UPDATE`, so a bare invocation cannot write even with both authorisation signals exported.
- Production writes additionally need `--i-am-authorised-to-write-to-production` **and**
  `OPS_ALLOW_PRODUCTION=seed:deprecations` — its own token, so authorising another runner does
  not authorise this one.
- Every write is **read back** and compared; a mismatch throws. A write that reports success
  without being observed is a claim, not a fact.

---

## What did NOT happen

**No production mutation.** The runner has never been invoked with `--apply`. Building the
mechanism is not permission to use it, and the owner's D-7C approval predates the D-7C-1a
finding — it was given without this conflict on the table.

`SKILL_CANONICALIZE_ENABLED` (false) · the 0.75 floor · `NO_REGRESSION` · the baseline · every
alias row and vector · `MATCH_SKILLS` · the bridge · promotion status · D-7A's hold ·
`decollided-aliases.json` (still 4 entries).

## Gates

```
MATCH_VOCABULARY          PASS — 0 of 96 missing a disposition
RESOLVABLE_ABOVE_FLOOR    FAIL — 34 of 96 blocked
NO_REGRESSION             FAIL — 96 of 96 blocked
EVAL_COVERED              PASS under fixture v3 (0 of 96 blocked)
PROMOTION CANDIDATES      96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED · D-7C SEED BLOCKED ON D-7C-1a.**


---

## OWNER RULING — 2026-08-26: **USE THE SELECTIVE GUARDED MECHANISM**

**Ruled:** proceed with the selective guarded seeder. Only the explicitly approved neutral
deprecations may be seeded. **`skill_boring` remains excluded.**

**Verified against live rows the same day, dry run, ₹0, nothing written:**

```
pnpm db:seed:deprecations --only=skill_gdt_reading,skill_cad_interpretation,skill_dimensional_inspection

  approved set  = skill_gdt_reading, skill_cad_interpretation, skill_dimensional_inspection
  excluded      = skill_boring   <- cannot be requested at all
  vocabulary the seed retires (expected): 3 phrase(s)
    dimensional inspection, inspection, quality check
  cross-decision orphans (refuses):      0        <- was 2 before the D-7C-1a ruling
  preconditions PASS. 3 row(s) would change.
```

**The `0` is the D-7C-1a ruling working.** Before it, the seeder refused: applying the
2026-08-21 elections and this seed together removed `GD&T` and
`geometric dimensioning and tolerancing` from retrieval entirely. Re-pointing the two exclusions
at the deprecation subject means the surviving holder keeps both, and the refusal cleared
without the precondition being relaxed — the check is unchanged and still reads live rows.

**The 3 retired phrases are expected coverage loss, not a defect.** A deprecation retiring its
*own* phrases is what a deprecation is. The cross-decision orphan count is the number that
matters, and it is zero.

**Still not executed.** This is a dry run. The apply is a production mutation and needs the two
ops-guard signals; it sits at step 4 of the activation sequence.

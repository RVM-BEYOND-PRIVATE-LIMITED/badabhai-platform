# The remaining programme — who is blocking what

**Prepared against main `feb73e75` · 2026-08-26 · repository-only**
**Production mutation: NONE · AI spend: ₹0**

Reproduce: `pnpm db:audit:programme-graph --json=<out>`
Source of truth: `packages/db/src/programme-graph.ts` · Artifact:
[`programme-graph.json`](./programme-graph.json) · Tests: `programme-graph.test.ts` (18)

> **`project-control.md` §H said *"No independently executable engineering task remains in this
> programme."*** It was true when written, and it stopped being true the same week. Nine
> engineering tasks have landed since. **Prose cannot be wrong out loud.** This graph is typed
> data with a validator, so it can be.

---

## The shape of it

```
EXECUTABLE                     0
BLOCKED_ON_OWNER              11
BLOCKED_ON_AI_SPEND            2     ₹0.028128 total
BLOCKED_ON_PRODUCTION_WRITE    3     mechanisms built, tested, never invoked
BLOCKED_ON_DATA                2
BLOCKED_ON_INFRA               4
COMPLETE                       8
```

The classification is about **who is blocking**, never about difficulty — because the six
blocker kinds are exactly the things an agent must not decide for itself, plus the one it cannot
do at all. That turns *"the programme is blocked"*, which is useless, into *"these people are
each holding one thread"*.

**Total spend to clear every spend-blocked item: ₹0.028128.** Not a rounding error in the budget
sense; it is a rounding error, and it is still unauthorised, which is the point.

---

## What can start today: nothing — and a retraction

**Zero executable items.** So `project-control.md` §H is *true today*: no independently
executable engineering task remains. It was **false** while the nine tasks that have since
landed were available, and the point of holding it as data is that it fails when it stops being
true rather than being right by luck.

### The retraction

The first version of this graph claimed **one** executable item: six write runners on the
activation path with no ops guard — `materialize-job-reach`, `normalize-skill-aliases`,
`seed-domain-skills`, `normalize-job-domain-aliases`, `backfill-worker-skills`,
`grant-free-tier`. It came from grepping each file for the literal string `enforceOpsGuard`.

**That method cannot see indirection, and all six reach the guard through it.** Each calls
`parseCommonCli` (`match-v1-cli.ts`), which calls `enforceOpsGuard` with `mutating: apply` and
also owns the missing-`DATABASE_URL` refusal. They are guarded, and better than the six-copies
alternative: the guard lives in **one** place.

The item is kept as `COMPLETE` with the retraction in its own evidence field rather than deleted,
and the test now checks the property by the method that can see it — if someone detaches one of
these from `parseCommonCli` without adding `enforceOpsGuard` directly, an `--apply` against
production stops needing two signals and the suite fails.

> **project-control's "4 unguarded write runners" is left as it stands.** This audit disproved
> its own count of six; it did not establish four, and replacing one unverified number with
> another is how the first mistake happened. A rigorous count needs call-graph analysis, not a
> grep.

## The eleven owner decisions

| id | decide |
|---|---|
| `D-7A` | boring: re-point, accept the widening, or keep the hold |
| `D-7C-1a` | the elections and the seed together orphan `GD&T` — re-point, drop, or accept the loss |
| `D-7C-1b` | which skill keeps `CAD` / `drawing padhna` / `read engineering drawings` / `technical drawing` |
| `5a-2` | the sibling margin: accept, minimum separation, or disambiguation group |
| `NO-REGRESSION-SEMANTICS` | strict v2-only, or split regression from coverage |
| `CNC-PROGRAMMING` | the slug — A/B/C |
| `TD-07` | `skill_welder_occupation` — T1..T4 |
| `OIE-CANONICALIZE` | should the OIE path populate `job_domain_id` |
| `MIGRATION-ORPHAN` | one production migration from a checkout that never reached `main` |
| `RESOLVABLE-28` | 28 skills resolve correctly below the floor; the remedy is aliases, and ratifying one is an owner act |
| `PROMOTION` / `CANONICALIZATION` | the two leaves |

**An item may not be `BLOCKED_ON_OWNER` without naming the decision.** The validator enforces it,
because *"waiting on the owner"* with no question attached is how an item waits forever.

### One of them is a conflict between two instructions, not between two options

`NO-REGRESSION-SEMANTICS` carries a live ambiguity: one instruction described a
*"regression-budget architecture"*, a later one said *"do not weaken the gate"*. Those select
different options. **The gate is untouched and the ambiguity is recorded rather than resolved by
guess** — and it is load-bearing, because the ruling decides which fixture the ₹0.028 evidence
run should use. Spending first and asking after would buy the wrong measurement.

---

## The two leaves

```
PROMOTION          blocked by  4
  BLOCKED_ON_AI_SPEND          NO-REGRESSION-EVIDENCE
  BLOCKED_ON_OWNER             NO-REGRESSION-SEMANTICS
  BLOCKED_ON_OWNER             RESOLVABLE-28
  BLOCKED_ON_AI_SPEND          RESOLVABLE-6

CANONICALIZATION   blocked by 12
  + 5a-2 · ALIAS-CLEANUP-APPLY · CANONICALIZE-FLAG-VALUE · D-7A
  + D-7C-1a · D-7C-1b · D-7C-SEED · PROMOTION
```

**No path to either leaf is engineering-only** — asserted by test. That is a stronger statement
than "blocked": it means finishing every executable task in the repository moves neither leaf,
and the remaining distance is measured in decisions, one infrastructure fact, and three
production writes.

`Q1` and `EVAL_COVERED` are direct dependencies of promotion and do **not** appear in its blocker
list, because they are `COMPLETE`. The graph reports what is still in the way, not the ancestry.

---

## Three mechanisms that exist and have never run

| id | runner | why it has not run |
|---|---|---|
| `ALIAS-CLEANUP-APPLY` | `db:decollide:aliases` | 4 elections ratified 2026-08-21 and still unapplied; 4 more unratified |
| `D-7C-SEED` | `db:seed:deprecations` | **refuses on its own precondition** — the D-7C-1a orphan |
| `FORENSICS-JOBS` | *(no runner yet)* | `jobs` 25→19 and `applications` 92→28 with no forensic record |

Each is dry-run-by-default with a two-signal ops guard, and each has a simulated outcome in the
register. **Building the mechanism was never permission to use it.**

---

## Two things nobody can answer from here

| id | needs |
|---|---|
| `CANONICALIZE-FLAG-VALUE` | one command on the box; the secret was changed 2026-08-24 and every deploy since carries it |
| `ONE-WORKER-PREDICATE` | the author of the 08-24 figure saying what it counted; five predicates were probed and none yields 1 |

And one that changed status without anyone acting: **`D6-1` is no longer starved of data.** It was
recorded as needing *"human authoring or worker traffic"* when the platform had one worker. There
are now **37 workers and 22 profiles**, so `db:mine:aliases` has real phrases to mine for the
first time. The constraint that made it impossible has lifted; the rule that agent-authored
paraphrases must never become ground truth has not, and mined **worker** language is not that.

---

## What the graph refuses to say

- No item is `EXECUTABLE` while depending on something unfinished — the rule that stops a plan
  promising work that cannot start.
- No item is `BLOCKED_ON_AI_SPEND` without a measured rupee figure, never a range.
- Every item cites an artifact, and a test opens each one.

## Gates

```
GATE_ACCEPTED · IS_PROVISIONAL · ACTIVE_EDGE · FULLY_EMBEDDED    PASS — 96/96
MATCH_VOCABULARY                                                 PASS — 0 of 96 missing
EVAL_COVERED                                                     PASS — 0 of 96 uncovered (retrieval-v3)
RESOLVABLE_ABOVE_FLOOR                                           FAIL — 34 of 96 (62 pass)
NO_REGRESSION                                                    FAIL — 96 of 96
PROMOTION CANDIDATES                                             96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED.**

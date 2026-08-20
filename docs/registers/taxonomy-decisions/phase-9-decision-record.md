# Phase 9 — the owner's ruling on the six open decisions

> **Decided 2026-08-20 by the platform owner**, on the analysis in
> [`phase-9-recommendations.md`](./phase-9-recommendations.md). That page recommends; this one
> records what was chosen and tracks what shipped against it.
>
> [`phase-9-open-decisions.md`](./phase-9-open-decisions.md) stays as the costing of the options
> and is now **historical** — read it for why an option was rejected, not for what is open.
>
> **Standing constraint on every row: nothing is applied to production without the owner's
> explicit approval.** Where a decision implies a production mutation, the engineering work stops
> at "reviewed, merged, and ready to run", and the run itself is listed under
> *Owner actions still outstanding* at the bottom.

---

## The ruling

| # | decision | ruling | status |
|---|---|---|---|
| 1 | `cnc-programming` | **A — accept the gap.** Do not build the new runner / embed path. | accepted; pinned by test |
| 2 | TD-07 | **T4 now, T1 at the first real welder.** | **shipped** |
| 3 | TD-01 seeding | **D2 — seed + embed, then promote**, trainer cases handled as specified. | sequenced; awaiting owner run |
| 4 | `EVAL_COVERED` | **E1 — keep the stricter promotion gate.** | **shipped**; 6 cases await a trainer |
| 5 | OIE canonicalization | **O2 now, O1 as the eventual proper fix.** | shipped, default-off |
| 6 | four unmodelled tables | **Keep and model them. Do not drop.** | shipped (declaration) |

Two constraints applied across all six:

- **All taxonomy flags stay unchanged.** `SKILL_CANONICALIZE_ENABLED`, `MATCH_V1_ENABLED`,
  `DOMAIN_MATCH_ENABLED` and the S3-D read switch are exactly as they were.
- **S3-D is not activated.** The shadow re-run stands as the readiness instrument; the switch is
  not flipped. See the measurement in `phase-9-recommendations.md`: the binding constraint is
  embedding coverage, not promotion.

---

## 2 — TD-07: T4, shipped

**What changed.** `signals._detect_welding` now carries the machining guard that
`_assign_welding_role` has carried since TAX-WELD-1, applied to the **unspecific** welding entry
only (`_UNSPECIFIC_WELDING_SKILL_IDS` = `{skill_welder_occupation}`).

**The asymmetry it removes, restated in one line:** the role bridge already refused to call a CNC
operator a welder; the attribute bridge wrote `skill_welder_occupation` anyway, which
`match-skills.ts` maps to the **specific** `mskill_mig_welder`, which
`MATCH_SKILL_RELATION_PAIRS` then carries to arc and TIG with the payer's related rows
pre-ticked. One passing mention of welding made a machining worker a MIG welder in the match
spine.

| | |
|---|---|
| production rows affected | **0** — no `worker_skill`, no `job_reach`, no posting names a welding skill |
| behaviour change for real welders | **none**; a named process (MIG / TIG / arc / gas) is untouched, and texts with no machining evidence are untouched |
| behaviour change for machining workers | an unspecific welding mention now records **nothing** instead of a specific MIG assignment |
| rollback | delete one `continue`; the constant it reads is inert without it |

**What T4 explicitly does not fix**, pinned as a test
(`test_t4_does_not_fix_the_finding_it_is_scoped_under`) so it cannot be mistaken for closure: a
TIG-only worker is still *additionally* written as MIG, and a self-described welder with no
machining context still lands on a specific process. Both need **T1**.

**T1's trigger, stated so it is not left to memory:** the first welding row anywhere —
`worker_skill` on any `mskill_*_welder`, or a `job_postings` requirement naming one. T1 mints
`mskill_welder_general`, which is permanent once written, and its backfill cost is proportional
to the rows that exist when it lands, so it is cheapest at 1.

**Deliberately not in T4:** the blocker guard. `welding_role_blocked` still suppresses the role
only, so a denial keeps its welding skill ids. That is a pre-existing, documented
gazetteer-family limitation, and a different failure class from writing a specific id off an
unspecific signal.

---

## 4 — `EVAL_COVERED`: E1, shipped

**What changed.** The gate reads a new predicate, `countsAsEvalCoverage` — *the case is
`reviewed`* — instead of `isScoreable`, which excluded only `pending_review`.

The two are kept SEPARATE rather than one being redefined, because they answer different
questions and conflating them is exactly how this drifted:

| predicate | question | a `mechanical` case |
|---|---|---|
| `isScoreable` | does this case produce a number? | **yes** — a real retrieval that can fail; excluding it would silently move every published metric |
| `countsAsEvalCoverage` | does this case prove the skill is findable? | **no** — its query is the skill's own alias, so it asks the index whether an exact string matches itself |

**Measured effect** on `retrieval-v2.jsonl`:

| | before | after |
|---|---|---|
| skills covered | 65 | **59** |
| of the 98-skill growth corpus | 61 | **55** |
| **live promotions blocked** | — | **0** |

Zero because all six demoted skills belong to the growth corpus, which is **0% seeded**;
production holds the disjoint wedge corpus. Asserted structurally in the tests, not claimed.

**Two things that were also wrong and are fixed with it.** The `demoted` list was
*unreachable* — with no `pending_review` cases in the fixture, `isScoreable` never demoted
anything, so the operator warning had never once printed. It now prints and **names** the
skills. And `embed-replay-queries` / `replay-path-a` printed `REVIEWED` for every mechanical
case, from the same conflation; both print the status verbatim now.

**The 6 trainer cases.** Generated as a pack of EMPTY slots, never as authored ground truth:

```
pnpm --filter @badabhai/db db:review-pack:eval-coverage
  -> data/taxonomy/eval/review-pack/e1-eval-coverage-trainer-pack.{json,md}
```

The pack calls `evalCoverage()` — the gate's own function — so it cannot describe a different
set from the one blocking, and it shrinks as slots are filled. **Engineering must not write
these six phrases.** A paraphrase authored by the process that then scores it measures nothing,
and here it would re-open precisely the hole E1 closed, one layer up.
`phase-9-trainer-worksheet.md` **Part 3** is the human-facing instruction.

**Rollback.** One predicate and its call site. `--waive EVAL_COVERED` was always the escape
hatch and is now, for the first time, reachable.

---

## Owner actions still outstanding

Nothing on this row list has been executed. Each is a production mutation.

| what | why it needs the owner | where it is written down |
|---|---|---|
| the TD-01 seed + embed + promote run | writes to production, and seeding creates Path A behaviour that no flag reverses | see the D2 section, added with that work |
| six trainer phrases for the E1-demoted skills | ground truth a trade trainer must author; engineering writing them would re-open the hole E1 closed | `e1-eval-coverage-trainer-pack.md`, and Part 3 of the trainer worksheet |

---

## Change log

| date | what |
|---|---|
| 2026-08-20 | Record opened. Ruling on all six recorded; TD-07 T4 shipped. |
| 2026-08-20 | `EVAL_COVERED` E1 shipped, with the trainer pack for the six skills it demotes. |

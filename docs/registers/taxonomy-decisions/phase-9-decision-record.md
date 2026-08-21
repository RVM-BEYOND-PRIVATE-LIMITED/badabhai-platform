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
| 1 | `cnc-programming` | **A — accept the gap.** Do not build the new runner / embed path. | **accepted**; inexpressibility pinned by test |
| 2 | TD-07 | **T4 now, T1 at the first real welder.** | **shipped** |
| 3 | TD-01 seeding | **D2 — seed + embed, then promote**, trainer cases handled as specified. | **runbook written, NOT run** — awaiting the owner |
| 4 | `EVAL_COVERED` | **E1 — keep the stricter promotion gate.** | **shipped**; 6 cases await a trainer |
| 5 | OIE canonicalization | **O2 now, O1 as the eventual proper fix.** | **shipped**; measured 0% coverage — O1 is now the whole fix |
| 6 | four unmodelled tables | **Keep and model them. Do not drop.** | **shipped** — model + migration `0084`, unapplied |

Two constraints applied across all six:

- **All taxonomy flags stay unchanged.** `SKILL_CANONICALIZE_ENABLED`, `MATCH_V1_ENABLED`,
  `DOMAIN_MATCH_ENABLED` and the S3-D read switch are exactly as they were.
- **S3-D is not activated.** The shadow re-run stands as the readiness instrument; the switch is
  not flipped. See the measurement in `phase-9-recommendations.md`: the binding constraint is
  embedding coverage, not promotion.

---

## 1 — `cnc-programming`: option A, the gap is accepted

**Ruling:** accept the loss. Do not build the compatibility-alias runner or the per-row embed
path option B needs.

**What is being accepted, precisely.** When S3-D retags `skill_cad_interpretation` onto
`skill_drawing_reading`, a caller scoped to the legacy slug `cnc-programming` loses **3 embedded
candidate rows** — the `en` aliases *CAD*, *technical drawing*, *read engineering drawings* —
and gains nothing back. Path B candidate rows under that slug go **11 → 8**, distinct skills
**4 → 3**.

**Three measurements make it cheap.**

| | |
|---|---|
| workers reaching Path B today | **0** — `SKILL_CANONICALIZE_ENABLED=false` |
| rows actually lost | **3, not 4** — `drawing padhna` (hi) has `embedding IS NULL` and was never a candidate, so Hindi drawing-reading is unserved under this slug *already*, before S3-D touches anything |
| callers that can scope to `cnc-programming` at all | **none** — every live path hard-codes `cnc-machining` or supplies a `jd_*` id |

**Why not B.** It is not "one additive row". Every shipped `skill_alias` writer derives
`domain_id` from the alias's own parent skill, so a cross-slug row is currently **inexpressible**
and needs a dedicated runner; it needs its own embed call (`db:embed:skills` has no per-row
scope); its only semantically correct target, `skill_drawing_reading`, **does not exist in
production**; and it would establish a cross-slug compatibility-alias pattern with no precedent
in the repository — a new data shape adopted to protect three rows on a switched-off path.

**Accepting a gap needs a guard, or it decays into an oversight.** `cross-slug-alias.test.ts`
pins the inexpressibility itself: it finds every file holding an `.insert(skillAliases)` call and
requires each `domainId:` expression to be one of a named, reasoned allow-list, all of which
resolve to the parent skill's own slug, to NULL, or to a value the database already had.

**When that test fails, this decision is back open.** A new writer that can set `domainId` from
somewhere else IS option B's machinery, whatever it was added for.

**What would change the ruling:** a dated S10. Option C ("moot") is only defensible with one, and
nobody has dated it — if S10 lands inside the S3-D window, C and A are the same decision.

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

## 3 — TD-01 seeding: D2, sequenced and NOT run

**Ruling:** D2 — seed with the promotion pass — re-read as **seed + embed, *then* promote**,
with the trainer cases handled as specified.

**The sequencing correction is the substance of the ruling.** Promotion on its own buys **one**
rankable skill: retrievability needs a retrievable status *and* an alias with a vector, and
exactly 1 of 111 provisional skills has the second. A run that promotes before it embeds looks
like progress and produces none.

```
seed job_domain_skill (236 edges) + the 98-skill corpus
  -> embed its 225 unvectored aliases        <- the step that actually moves coverage
    -> promote
      -> re-measure (shadow, parity, coverage)
        -> only THEN consider S3-D
```

**Why D2 and not D1 or D3.** All three differ only in *when*, and the risk is real and was
under-weighted: **seeding is the step that turns Path A on in fact, whatever the flags say** —
`DOMAIN_MATCH_ENABLED` gates the ANN fallback, not the presence of edges, and no flag un-seeds a
table. D1 takes that irreversible step furthest from the observation that justifies it. D3
concentrates seeding, embedding, promotion and the read switch into one window, so a regression
would have four candidate causes and no way to bisect them.

**What shipped: the runbook, not the run.**
[`phase-9-d2-seed-embed-promote-runbook.md`](./phase-9-d2-seed-embed-promote-runbook.md) — five
read-only preconditions to record first, the four steps with their real commands and what each
writes, and an honest rollback table (step 1 is **not** reversible; step 3 is).

**It surfaced a blocker worth insisting on.** Every runner on the D2 path — `seed-skills`,
`match-v1-cli` (which `seed:domain-skills` uses), `embed-skill-aliases` and `promote-skills` —
still guards on `process.env.NODE_ENV === "production"`. `ops-guard.ts` exists precisely because
that guard protects the wrong thing (the process, not the target) and four other runners have
already moved to it. Since this repository's local `.env` points at production and `NODE_ENV` is
not normally set there, **the largest irreversible write in the phase would currently proceed
with no authorisation signal at all** — the "FALSE PERMIT" that file names. Migrating those four
is recommended *before* D2 runs, and is raised separately rather than folded into this decision.

**What would change the ruling:** a dated S3-A. If S3-A slips indefinitely, D2 becomes "never"
and the choice is genuinely between D1 and D3.

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

## 5 — OIE canonicalization: O2 shipped, and it measured 0%

**What changed.** The processor's legacy `/profile/extract` branch — the only route that
canonicalizes — now derives a canonical `jd_*` scope from the session's occupation pin and puts
it on the wire as `ProfileExtractionInput.job_domain_id`.

**What sending it does.** `job_domain_id` is not a flag, it *is* the S3-C read switch for this
caller: supplying it moves the TAX-4 canonicalization pass from Path B (`skill_alias.domain_id`,
the configured legacy slug) to Path A (`job_domain_skill`).

**What it does today: nothing.** The pass sits behind `skill_canonicalize_enabled`, `False` by
default and OFF in production, so the field rides the request and is never read. This arms the
switch; the taxonomy flag is what activates it, and that flag is untouched.

**Three refusals, all failing to "no scope"** — which is the pre-existing behaviour, so each
refusal is a no-op rather than a degradation: an absent or `unmatched_*` pin (five of the seven
statuses are unmatched, and the schema **defaults** to one, so a pin object is not a confirmed
trade); a domain that is no longer `selectable`/`active`; and a failure of the validation query
itself.

### The measurement, and it reorders the decision

`db:report:oie-canonicalize-coverage` — new, read-only, SELECTs only — measured production on
2026-08-20. **n=92 sessions, not the n=7 the readiness findings quoted.**

| | sessions |
|---|---|
| `conversation_state IS NULL` — canonicalizes, nothing to scope | **48** |
| answer map present — takes the OIE branch, **never canonicalizes** | **44** (32 of them carry a pin) |
| **empty answer map AND a pin** — the population O2 covers | **0** |
| extraction jobs with no session at all | 18 |

```
O2 coverage of the canonicalizing path : 0.00%
O2 coverage of ALL extractions         : 0.00%
```

**The two populations are perfectly disjoint, and structurally so.** Every session that carries
a pin also carries an answer map: an interview that pins an occupation then goes on to collect
answers. The "pinned then collected nothing" case the wiring was for has occurred **0 times in
92**. The readiness findings called n=7 directional; at n=92 it is the shape of the data.

**So O1 is where all the coverage is** — 44 sessions, every one of the 32 that carry a pin. O2
reaches none of them, because they are on the branch that does not canonicalize at all.

**This is O2 working as chosen, not failing.** It was preferred to O1 precisely because *"its
incompleteness is measurable rather than assumed"*, and the recommendation named this outcome in
advance: *"if it covers little, O1 is the priority and O2 was still the right way to find that
out."* The number is now in hand instead of being an inference, the scope-derivation and its
three refusals are the parts O1 will reuse, and shipping it cost zero behaviour change.

**O1's trigger is therefore now, not "eventually".** It moves the canonicalize pass out of the
branch it sits in, which is a control-flow change on the hot profiling path and needs the
extraction suite pinned *before* the move. That is the next engineering step on this decision,
and it is not started.

**Rollback.** Delete the two lines at the call site; the helper and its refusals become dead
code, and the request returns to its exact three keys.

---

## 6 — the four unmodelled tables: kept and modelled

**Ruling:** keep them, model them, do not drop. This **reverses** `0082`'s own recorded
recommendation (*"DROP IS THE BETTER END STATE, AND IS NOT THIS MIGRATION"*), and the reversal
is the point: dropping is the only irreversible option available, and it buys nothing measurable
against tables that hold 0 rows, carry 0 inbound FKs, and are already locked.

**What shipped.**

| | |
|---|---|
| model | `packages/db/src/schema/payer-onboarding.ts` — all four, matching the live catalog name for name |
| migration | `0084_model_gap_db_21_payer_onboarding` — creates them where they are absent, no-ops where they are not |
| contract | four `rls` entries in `SCHEMA_REQUIREMENTS`, which the manifest could not carry while they existed on production alone |
| e2e | added to `rls-spine.e2e.test.ts`'s `LOCKED_TABLES`, which used to exclude them in prose |
| adoption | an effect verifier keyed to the tag, for the one `to_regclass`-guarded statement |

**Constraint names are the LIVE ones** (`_fkey` / `_check` / `_key`), not Drizzle's `_fk`
convention, because `adopt-migrations.ts` verifies constraints against the live catalog by name.
A Drizzle-flavoured name would have made the migration unadoptable against the single database
that already has these constraints.

**The one thing not modelled:** `payer_member_invites.accepted_by_user_id → auth.users(id)`.
That schema is Supabase's and does not exist on a plain Postgres, and declaring it in Drizzle
would make Drizzle try to CREATE it. The column is modelled; the constraint lives in the
migration behind a `to_regclass('auth.users')` guard. The model holds what is portable, the
migration holds what is environment-specific.

### Verified against production, read-only, before merge

```
adopt-migrations --only=0084_model_gap_db_21_payer_onboarding
  -> clean=1  mismatched=0   (full static parse + 24 effect assertions)
```

That is a proof, not a claim: every table, column, index, constraint, RLS state and grant the
migration declares already matches production object for object. **Applying it there changes
nothing.**

### What modelling immediately found

**Two encrypted columns were unrotatable and nothing could say so.**
`employer_profiles.gst_number_enc` and `payer_member_invites.invited_email_enc` have held
`encryptPii` tokens since the tables were created out of band. The key-rotation coverage guard
derives its column list from the SCHEMA, so while no schema file described these tables the
guard passed — and a `kid` those columns depended on could never have been retired, with nothing
anywhere to explain why. Declaring the tables failed that test on the first run. Both are now
re-encrypt targets, which costs nothing today (0 rows) and makes the first row ever written
rotatable.

That is the argument for modelling over dropping, made concrete: the gap was invisible
*because* the tables were undeclared.

### Two hazards this hit, both worth remembering

1. **The slot collision.** Minted as `0083`; `#1130` took that number and landed on `main`
   mid-flight — the fifth collision this repository has recorded. Regenerated, not renamed, so
   the snapshot chain stays unbroken.
2. **The high-water mark, again.** `drizzle-kit` stamped this file at `1787226261060`, BELOW
   `0083_ai_call_traces`'s `1787230000000`. Left alone the migrator would have skipped it
   **silently and permanently** — no error, no output, just a fresh database that never gets the
   four tables. Hand-raised to `1787240000000`, and pinned by a test.

**And it explains the orphan.** `--doctor` had been reporting an unexplained recorded row at
`created_at = 1787230000000`, read as "a checkout that never reached `main`". It was
`0083_ai_call_traces`, applied to production ahead of its own PR. `--doctor` now reports
**0 orphans**.

**Rollback.** `DROP TABLE` is *not* the rollback: on production these tables predate the
migration. Revert the schema file and the migration in git; on a fresh database, where they were
genuinely created here, drop all four.

---

## Owner actions still outstanding

Nothing on this row list has been executed. Each is a production mutation.

| what | why it needs the owner | where it is written down |
|---|---|---|
| the TD-01 seed + embed + promote run | writes to production, and seeding creates Path A behaviour that no flag reverses | see the D2 section, added with that work |
| apply migration `0084` | it is a no-op on production and verified as one, but it is still a migration against the live database | `MIGRATIONS.md`, the `0084` row |
| six trainer phrases for the E1-demoted skills | ground truth a trade trainer must author; engineering writing them would re-open the hole E1 closed | `e1-eval-coverage-trainer-pack.md`, and Part 3 of the trainer worksheet |

---

## Change log

| date | what |
|---|---|
| 2026-08-20 | Record opened. Ruling on all six recorded; TD-07 T4 shipped. |
| 2026-08-20 | `cnc-programming` A accepted and pinned; D2 sequenced into a runbook that has not been run. |
| 2026-08-20 | `EVAL_COVERED` E1 shipped, with the trainer pack for the six skills it demotes. |
| 2026-08-20 | GAP-DB-21 modelled: schema file + migration `0084`, verified read-only against production as a no-op. Found two unrotatable encrypted columns on the way. |
| 2026-08-20 | OIE O2 shipped with its coverage report. Measured **0.00%** on n=92 — the covered population is empty and structurally so, and O1 now carries the whole decision. |

# Phase 9 — the six open decisions, with a recommendation on each

> **What this adds to [`phase-9-open-decisions.md`](./phase-9-open-decisions.md).** That page
> costs the options and deliberately stops short of choosing. This one chooses — it states a
> recommendation per decision, with the measurement that drives it and what would change it.
> Nothing here is applied; each remains the owner's call. Where the two pages disagree on a
> *number*, this one is later and was re-measured on 2026-08-20.
>
> **One measurement taken today reorders four of the six**, so it is stated once here rather
> than repeated in each section.

---

## The measurement that reorders the page

The S3-D shadow's headline has been *"Path A returns nothing on 65 of 123 cases because most
canonical skills are still `provisional`; S3-D cannot be flipped before promotion."* The first
clause is a real measurement. The second is an inference, and running the instrument against it
shows it is **wrong**.

`db:report:s3d-shadow --if-promoted` re-runs every signal over a corpus where provisional skills
are retrievable. The result is **identical to six decimal places**:

| | production semantics | `--if-promoted` |
|---|---|---|
| cases | 123 | 123 |
| Path A empty | **65** | **65** |
| Path B empty | 0 | 0 |
| both resolved | 58 | 58 |
| agree on top-1 | 9 | 9 |
| disagree | 49 (15.52% agreement) | 49 (15.52% agreement) |
| score delta (A−B) | min −0.158062 · p50 0 · p95 0.136072 · max 0.159031 | identical |

Signal 0 — the candidate-pool composition, now printed by the report — says why:

| status | skills | aliases embedded |
|---|---|---|
| `active` | 30 | 72 / 94 |
| `deprecated` | 6 | 11 / 15 |
| **`provisional`** | **111** | **1 / 226** |

**A skill needs two things to be rankable: a retrievable status and an alias with a vector.
Promotion moves only the first.** Exactly **one** provisional skill has an embedded alias, so
promoting all 111 adds one candidate — which is why the counterfactual is flat.

**The binding constraint on S3-D is embedding coverage, not promotion.** That is a provider run
plus a seed, not a status flip. Everything downstream that was "waiting for promotion" was
waiting for the wrong thing.

**And production is further back still.** The shadow is offline and reads the *corpus files*.
Production holds a **disjoint** population: 51 skills (all `active`, the wedge corpus), **zero**
of the 98-skill growth corpus, and **`job_domain_skill` = 0 edges**. Path A in production has no
edges at all, so its live empty-rate is 100%, not 52.85%. Do not quote the shadow's figure as a
production number.

---

## 1. `cnc-programming` — **recommend A (accept the loss)**

| | |
|---|---|
| blast radius | **11 Path B candidate rows → 8**; 4 distinct skills → 3 |
| rows that leave | 3 `skill_cad_interpretation` `en` aliases (CAD · technical drawing · read engineering drawings) |
| already inert | `drawing padhna` (hi) — `embedding IS NULL`, never a candidate before or after |
| live exposure | `SKILL_CANONICALIZE_ENABLED=false`. **0 workers** reach Path B today |
| rollback | A: nothing to roll back. B: a new runner, a new manifest, a new rollback path |

**Why A.** B is not "one additive row". No shipped runner can write it — every `skill_alias`
writer derives `domain_id` from the parent skill, so a cross-slug row is currently
*inexpressible* and needs a dedicated runner. It needs its own embed call (`db:embed:skills` has
no per-row scope). Its only semantically correct target, `skill_drawing_reading`, **does not
exist in production**. And it would establish a cross-slug compatibility-alias pattern with no
precedent in the repo — a new data shape adopted to protect three alias rows on a path that is
switched off.

**What would change this:** a dated S10. C ("moot") is only defensible with one, and nobody has
dated it. If S10 lands inside the S3-D window, C and A are the same decision.

---

## 2. TD-07 — **recommend T4 now, T1 when the first welder is profiled**

| | |
|---|---|
| blast radius **today** | **0 welding rows anywhere** — no `worker_skill`, no `job_reach`, no posting names a welding skill |
| cost of every option | therefore **free today**; each acquires a backfill at the first welder profiled |
| T4 scope | one predicate — `_detect_welding` gains the machining guard `_assign_welding_role` already has |
| rollback | T4: revert one predicate. T1: a new vocabulary id, which is permanent once written to `worker_skill` |

**Why T4 first.** It is the only option that is both cheap and *strictly* an improvement: it
stops the attribute bridge writing a specific MIG assignment from an unspecific "welder" signal,
using a guard that already exists on the sibling path. The register is right that T4 "does not
fix the finding" — a self-described welder still ends up with no welding skill — but that is a
*recall* gap on a population of **zero**, and it removes a *correctness* defect that would
otherwise write a wrong specific skill into the audit trail from the first day welders arrive.

**Why T1 later, not now.** T1 is the real fix and it mints a new vocabulary id
(`mskill_welder_general`) plus new relation edges. A vocabulary id is effectively permanent once
it reaches `worker_skill`, and there is no data yet to validate the relation edges against.
Minting it now spends the irreversible step at the moment of least information.

**Do not choose T2.** It leaves a self-described welder with no matched skill at all, which is a
silent recall hole rather than a wrong answer — the harder class to notice.

**What would change this:** the first welding row anywhere. Re-measure then; T1's backfill cost
is proportional to it and is smallest at 1.

---

## 3. TD-01 seeding — **recommend D2 (seed as part of S3-A)**

| | |
|---|---|
| what is missing | `job_domain_skill` = **0 edges** in production; the corpus file holds **236** over 28 domains |
| also missing | the 98-skill growth corpus is **0% seeded**; **225 of 226** of its aliases have no vector |
| affected today | Path A retrieves nothing, for every query, in production |
| rollback | seeding *creates* Path A behaviour where none exists. **No flag reverses it** — `DOMAIN_MATCH_ENABLED` gates the ANN fallback, not the presence of edges |

**Why D2.** The three options differ only in *when*, and the risk the register names is real and
under-weighted: seeding is the step that turns Path A on in fact, whatever the flags say. D1
("seed now") takes that irreversible step furthest from the observation that would justify it.
D3 ("seed with S3-D") concentrates seeding, promotion and the read switch into one window, so a
regression has three candidate causes and no way to bisect them.

D2 seeds with the promotion pass — one authorisation, an already-written sequence, and the seed
lands *before* the switch so its effect is observable on its own.

**The sequencing correction that matters.** D2's "with the promotion pass" must now be read as
**seed + embed, then promote**. Promotion on its own buys one candidate (see the measurement
above); the embed run is the step that actually moves coverage. The dependency order is:

```
seed job_domain_skill (236 edges)  ->  seed the 98-skill corpus  ->  embed its 225 aliases
   ->  promote  ->  re-run the shadow  ->  only then consider S3-D
```

**What would change this:** a dated S3-A. If S3-A slips indefinitely, D2 becomes "never" and the
choice is genuinely between D1 and D3.

---

## 4. EVAL_COVERED — **recommend E1 (the spec is right), and it is now nearly free**

| | |
|---|---|
| live promotions blocked by the strict reading | **0** — all 6 mechanical-only skills are ABSENT from production |
| cost | 6 trainer cases |
| what promotion buys at all | **1 rankable skill** (see the measurement above) |
| rollback | two words and a test; `--waive EVAL_COVERED` already exists as the escape hatch |

**Why E1.** A mechanical `corpus_alias:*` case is an exact echo of the skill's own alias, so a
skill covered only by one is self-certifying — it proves the index works, not that the skill is
findable from anything a worker would say. The gate's stated purpose is *"we only promote what
we have actually MEASURED"*, and E1 is the reading that matches it.

**Why the cost argument has changed.** This was framed as "a policy change wearing a bug fix's
clothes", priced at 6 trainer cases against an unknown benefit. The benefit side is now measured:
promotion in its current state adds **one** rankable skill. So the strict reading forgoes
essentially nothing, and tightening it while the population is zero is the cheapest this decision
will ever be.

**E3 is the acceptable second choice** — it keeps both sets and forces `--waive EVAL_COVERED`
with a recorded waiver. It is strictly more machinery for the same outcome, and the waiver path
already exists and is unreached. Prefer E1; take E3 if the trainer capacity for 6 cases is not
available in this cycle.

**Do not choose E2.** It resolves the spec/code disagreement by weakening the spec to match the
code, which is the direction that loses information.

---

## 5. OIE canonicalization — **recommend O2 now, O1 as the real fix**

| | |
|---|---|
| the blocker | the OIE occupation pin and the canonicalize pass sit on **mutually exclusive branches** |
| O2 completeness | partial, and **measurable** — the shadow reports the fraction |
| O1 completeness | complete; touches the processor's control flow |
| rollback | O2: one field. O1: a control-flow change, needs the full processor test set |

**Why O2 first.** It is one field on the branch that already carries the pin, it cannot regress
the other branch because it does not touch it, and — the deciding property — **its incompleteness
is measurable rather than assumed**. Shipping O2 converts "we don't know what fraction of the OIE
path canonicalizes" into a number, and that number is what tells you whether O1 is urgent.

**Why not O3.** Reading the persisted prior match is stale by one interview: a worker whose
occupation changed is canonicalized against the occupation they no longer have. That is a wrong
answer produced silently, which is worse than O2's honest partial coverage.

**What would change this:** O2's measured fraction. If it turns out to cover most traffic, O1
becomes routine cleanup; if it covers little, O1 is the priority and O2 was still the right way
to find that out.

---

## 6. The four unmodelled tables — **recommend keeping them, and modelling them instead**

Measured on production, 2026-08-20:

| table | rows | columns | inbound FKs |
|---|---|---|---|
| `agency_profiles` | **0** | 9 | 0 |
| `employer_profiles` | **0** | 10 | 0 |
| `payer_capabilities` | **0** | 12 | 0 |
| `payer_member_invites` | **0** | 13 | 0 |

All four are empty, nothing references them, and since `0082` all four are **RLS-enabled, FORCED
and revoked from every Data-API role** (`db:audit:rls`: 78 tables, 78 locked, 0 deviating). They
are inert.

**Why not drop.** Dropping buys nothing measurable — they are empty, locked, and carry no
inbound FK. It costs a migration against tables no schema file describes, which means the
migration would be written from the live catalog rather than from a model, and a fresh database
would need a `to_regclass` guard exactly like `0082`'s. Their column names
(`employer_profiles.gst_number_enc`, `payer_member_invites.invited_email_enc`) read as a
deliberate, unfinished payer-onboarding design rather than debris; dropping is the one option
that is irreversible if that is right.

**Recommended instead:** declare them in the schema. That closes `GAP-DB-21` at its root — a
declared table is covered by `db:audit:live-drift`, by the schema contract, and by a future
migration's model. The decision "do we still want this design" then becomes a product question
answerable at leisure, rather than a blocker on a locked empty table.

**Scope note.** `db:audit:live-drift` (new) reports **six** undeclared tables, not four:
`_delete_forensics` and `ai_call_traces` join the known set. `_delete_forensics` holds **147
rows**, is written by a live trigger on `workers`, and exists in no migration — raised
separately as **#1110**, and it must not be dropped.

---

## Summary

| # | decision | recommendation | why, in one line | what would change it |
|---|---|---|---|---|
| 1 | `cnc-programming` | **A — accept the loss** | B needs a new runner, a new embed path and a target skill that does not exist, to protect 3 alias rows on a switched-off path | a dated S10 |
| 2 | TD-07 | **T4 now, T1 at the first welder** | 0 welding rows; T4 removes a wrong write cheaply, T1 mints a permanent id best spent with data | the first welding row anywhere |
| 3 | TD-01 seeding | **D2 — with S3-A**, re-read as *seed + embed, then promote* | seeding is irreversible and D2 is the only order where its effect is observable alone | a dated S3-A |
| 4 | `EVAL_COVERED` | **E1 — the spec is right** | blocks 0 live promotions, costs 6 trainer cases, and promotion buys 1 skill anyway | trainer capacity → then E3 |
| 5 | OIE canonicalization | **O2 now, O1 as the real fix** | its incompleteness is measurable, which is what tells you whether O1 is urgent | O2's measured fraction |
| 6 | four unmodelled tables | **keep; model them** | empty, locked, inert — dropping is the only irreversible option and buys nothing | a product ruling that the design is dead |

**None of these is applied.** Four of the six (1, 2, 4, 6) are at their cheapest right now
because the affected populations are zero, and that window closes at the first seed.

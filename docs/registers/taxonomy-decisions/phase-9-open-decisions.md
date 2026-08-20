# Phase 9 — the six open decisions, costed

> **What this is.** One page per open item: what it is, what it costs *measured against
> production today*, and the implementation options with their real prices. It chooses nothing.
> Each item ends with who can choose and what changes the moment they do.
>
> **Measured read-only against production on 2026-08-20.** Cluster `7642734024280108049`. No
> flag changed, no row written. Every number below is reproducible with the command beside it.

---

## The measurement that reframes four of the six

Before the individual items, one production fact that most of them turn on and that none of the
earlier write-ups had:

| | measured |
|---|---|
| `skill` rows | **51 — all `active`**: 33 `attribute` + 18 `match_skill` |
| canonical corpus skills (`skill_*` from `data/taxonomy`) | **0 seeded** |
| `job_domain_skill` edges | **0** (the corpus file holds 236) |
| `worker_skill` rows | **6**, all `derived_coarse` |
| `job_reach` rows | **4** |
| `unresolved_phrase` rows | 34 — 32 `occupation`, 2 `skill`, **0 carrying `job_domain_id`** |
| workers | 77 |

**The canonical taxonomy exists as schema and not as data.** `0076` created the tables and
nothing has been seeded into them. Path A therefore has no edges *at all* in production — which
is a stronger statement than "most canonical skills are provisional", and it means:

- every taxonomy option below is currently a change to **corpus files and Path B alias rows**, not
  to live retrieval behaviour;
- the blast radius of getting one of them wrong is, today, **zero rows**;
- and that stops being true the moment anyone runs the seed. The cheap window is now.

```bash
pnpm --filter @badabhai/db db:audit:schema-contract   # schema
pnpm --filter @badabhai/db db:verify:taxonomy         # corpus
pnpm --filter @badabhai/db db:report:s3d-shadow       # Path A vs Path B
```

---

## 1. `cnc-programming` — a taxonomy decision, unchanged and re-measured

**The full package is [`phase-9-cnc-programming-decision.md`](./phase-9-cnc-programming-decision.md).**
Re-measured today; every number in it still holds:

| | 2026-08-19 | 2026-08-20 |
|---|---|---|
| Path B candidate rows under `cnc-programming` | 11 | **11** |
| distinct skills reachable | 4 | **4** |
| alias rows carrying the slug | 14 | **14** |

**The question.** At S3-D the retag moves `skill_cad_interpretation`'s aliases to
`cnc-machining`. A query scoped to `cnc-programming` then stops reaching *any* drawing-reading
phrase — 3 retrievable aliases lost (not 4: `drawing padhna` has no embedding, so Hindi is
unserved there today either way).

| option | cost | consequence |
|---|---|---|
| **A — accept the loss** | none | a CNC programmer stops matching drawing-reading phrases for the S3-D → S10 window |
| **B — a legacy alias row under `cnc-programming`** | one row **+ one embed call + a new runner** | closes it; additive and reversible |
| **C — treat it as moot** | none | only defensible if S10 is near, and **nobody has dated S10** |

**B's price is not "one row"**, and this is the part worth re-reading: every shipped
`skill_alias` writer derives `domain_id` from the parent skill, so a cross-slug row is currently
*inexpressible* and needs a dedicated runner with its own manifest and rollback. It also has no
precedent in this repo — B establishes a new data pattern rather than following one. And its only
semantically correct target, `skill_drawing_reading`, **does not exist in production** (measured:
ABSENT), so B is sequenced strictly after S3-A.

**Amplifier from the table above.** No live caller can scope a query to `cnc-programming` at all
— every production path hard-codes `cnc-machining` or supplies a `jd_*` id that nothing
populates. The loss is real in the data and, today, unobservable in traffic.

**Decides:** taxonomy owner. **Engineering position:** none — all three are implementable, and B
is the only one with an engineering cost worth pricing before choosing.

---

## 2. TD-07 — `skill_welder_occupation → mskill_mig_welder`

**The finding, restated.** This was filed as a *gap* ("there is no generic welding skill"). The
measurement showed it is not a gap but an **incorrect specific assignment that already ships**.
A worker who says only TIG is written as a MIG welder too, with the identical bucketed
experience total.

| a worker says | what is written |
|---|---|
| `"welder hun main"` | `mskill_mig_welder` |
| **`"tig welding karta hu 5 saal"`** | **`mskill_mig_welder`, `mskill_tig_welder`** |
| `"arc welding aur gas cutting"` | `mskill_arc_welder`, `mskill_mig_welder` |
| `"cnc operator hun, welding bhi kar leta hun"` | `mskill_cnc_operator_general`, `mskill_mig_welder` |

Two bridges converge on the same specific process and there is no generic id to land on —
`packages/taxonomy/src/match-skills.ts:488` (`skill_welder_occupation`) and `:404` (`role_welder`).
The whole welding vocabulary is three ids. Blast radius runs one hop further than the write:
`MATCH_SKILL_RELATION_PAIRS` makes arc/mig/tig mutually related and `relatedSkillsDefault` is
`"on"`, so the payer sees the related rows **pre-ticked**.

### What it costs today, measured

| | rows in production |
|---|---|
| `worker_skill` where `skill_id = 'mskill_mig_welder'` | **0** |
| `mskill_arc_welder` / `mskill_tig_welder` | **0** / **0** |
| workers carrying both MIG and TIG (the row-3 shape) | **0** |
| `job_reach` rows on any welding skill | **0** |
| `job_postings` naming a welding skill | **0** |
| `worker_profiles.canonical_role_id` | 4 rows: `role_vmc_operator` ×2, `role_cnc_programmer`, `role_designer` |

**Nobody is affected yet.** The welding cohort has not arrived. Every remedy below is therefore
a code-and-vocabulary change with **no backfill and no correction of live profiles** — and every
one of them acquires a backfill the moment the first welder is profiled. `MATCH_V1_ENABLED` is
default-off and gates only the READ; the write path runs regardless
(`profile-extraction.processor.ts:455` is explicitly not gated), so rows accumulate before
anyone can see them.

### Implementation options

| | change | cost | what it fixes | what it does not |
|---|---|---|---|---|
| **T1 — add `mskill_welder_general`** | new vocabulary id; repoint both bridges onto it; new `MATCH_SKILL_RELATION_PAIRS` edges to the three specifics; seed | largest. A new id is a new payer picker option and a new reach bucket, so it changes what an employer can *require*, not only what a worker is recorded as | rows 1, 2 and 3 — an unspecific signal lands on an unspecific id | needs the relation edges designed, or a general welder reaches nothing |
| **T2 — write nothing for the unspecific signal** | delete two bridge entries (`:488`, `:404`) | two table entries + tests | rows 1, 2, 3 | a self-described "welder" then has **no match skill and no reach at all** — strictly worse for that worker than a wrong-but-adjacent one, unless T1 lands with it |
| **T3 — keep MIG, mark it low-confidence** | a confidence/derivation column on `worker_skill`, respected by rank and by the pre-tick default | migration + rank-rule change + two UI surfaces | the *consequence* rather than the assignment | the profile still says MIG; the résumé boundary already holds, but the feed card does not |
| **T4 — gate the attribute bridge like the role bridge** | `_detect_welding` gains the machining guard `_assign_welding_role` already has | smallest, ~one predicate | row 4 only | **not row 3.** The TIG-only worker is still written as MIG |

**T4 is the cheapest and does not address the finding.** It is listed because the asymmetry it
fixes is real and would otherwise be re-discovered later; it is not a substitute for T1 or T2.

**Decides:** taxonomy owner (and product, for T1 — it changes the employer's requirement
vocabulary). **Engineering position:** none on which. Engineering can say the register's original
framing predates the measurement, and that the cost of every option is at its minimum right now.

---

## 3. OIE canonicalization — should the OIE path populate `job_domain_id`?

**The mechanism.** There is no feature flag for the S3-C read switch. Which field the caller
populates *is* the switch: `job_domain_id` selects Path A, `domain_id` selects Path B. The
plumbing exists end to end as of `#1024` — contract field, router propagation, skill-store
protocol, and the canonical miss path — and **nothing populates it**. Measured:
`unresolved_phrase` holds **0 rows with `job_domain_id`**, so any option below starts from a
clean zero and shows up in `db:report:s3d-shadow` the first time it fires.

**The recommendation on record** ([`phase-9-s3d-readiness-findings.md`](./phase-9-s3d-readiness-findings.md) §1.2):
the **OIE occupation pin** (`processor.ts:337` — *"THE PIN TAKES PRECEDENCE"*), not either of the
two options originally listed. It is the only value in the request that is already an authoritative
`jd_*` id chosen for this worker.

**The blocker** (§1.3): the pin and the canonicalize pass sit on **mutually exclusive branches** of
the processor. Where the pin exists the canonicalize pass does not run, and where the pass runs
there is no pin. This is a structural problem, not a wiring one, and it is the reason the switch
is still unpopulated.

| | change | cost | coverage | risk |
|---|---|---|---|---|
| **O1 — restructure so both branches reach the canonicalize pass** | move the pass out of the branch it currently sits in | the real fix; touches the processor's control flow, needs the full extraction suite green | complete | control-flow change on the hot profiling path; behaviour must be pinned by tests *before* the move, not after |
| **O2 — populate only on the branch that already has the pin** | one field, no restructure | smallest | **partial, and measurable** — the shadow report will show the fraction | leaves two paths recording misses under different scopes, which the widened `unresolved_phrase` key already tolerates by design |
| **O3 — read the persisted prior match instead** | a repository read at canonicalize time | one query on a hot path | complete | stale by one interview; a worker whose occupation changed is scoped to the old one, silently |

**O2 is reversible and observable; O1 is correct; O3 buys completeness with staleness.** They are
not exclusive — O2 then O1 is a valid sequence, and O2's coverage number is the argument for
whether O1 is worth its risk.

**Decides:** product owner, on one question only — *should the OIE profiling path canonicalize at
all?* Once that is yes, which option is engineering's call and the answer is O2 then O1.

---

## 4. TD-01 — ratified, applied to corpus files, **not in the database**

[`phase-9-td-01-edge-decision.md`](./phase-9-td-01-edge-decision.md) is RATIFIED and applied: 14
edges re-pointed onto `skill_drawing_reading`, 12 re-pointed and 2 absorbed as duplicates, corpus
edge total 238 → 236, verified against the replay counterfactual on all ten metrics exactly.

**Corpus files only. Measured in production today:**

| | production |
|---|---|
| `skill_drawing_reading` | **ABSENT** |
| `skill_gdt_reading` | `active` — still the pre-merge state |
| `skill_cad_interpretation` | `active` — still the pre-merge state |
| `job_domain_skill` edges | **0** (corpus holds 236) |

So the ratified decision has had **no effect on production** and cannot until someone seeds. That
seed is a production mutation that changes retrieval, which is exactly the class of action held
for explicit authorisation.

| | when | cost | risk |
|---|---|---|---|
| **D1 — seed now** | before S3-A | the seed runner exists and is manifest-driven | Path A has 0 edges today, so seeding *creates* Path A behaviour where there was none. That is a bigger change than it sounds and it is not reversible by a flag |
| **D2 — seed as part of S3-A** | with the promotion pass | one authorisation instead of two; the sequence is already written | S3-A is not dated |
| **D3 — seed with S3-D** | at the switch | smallest window between change and observation | concentrates several irreversible steps into one window |

**Also still open on TD-01, and neither is engineering's:** the 11-case provider gap needs trainer
ground truth, and fixture coverage for `skill_drawing_reading` is now *possible* (the edges exist,
so `validateEvalFixture` will no longer refuse it) but unwritten.

**Decides:** taxonomy owner for the sequencing; a human for the trainer cases.

---

## 5. `EVAL_COVERED` — a two-word edit that is a policy change

**The contradiction.** The C5 spec says in prose *"Mechanical `corpus_alias:*` cases do NOT
count"*. The implementation uses `isScoreable(c)`, which is
`reviewStatusOf(c) !== "pending_review"`. `reviewStatusOf` returns one of three values and the
implementation excludes exactly one — the one the spec never mentions.

**Measured, both shipped fixture versions (`retrieval-v1.jsonl` and `retrieval-v2.jsonl`), and
they agree exactly:**

| | count |
|---|---|
| cases | 127 |
| `mechanical` | **39** (24 `exact_alias` + 15 `devanagari_alias`) |
| `reviewed` | 88 |
| `pending_review` | **0** |
| skills covered at all | 65 |
| **skills covered ONLY by mechanical cases** | **6** |

Because there are zero `pending_review` cases, **the earlier PR-1 fix (`#953`) is a behavioural
no-op on the shipped fixture** — the covered set is 65 either way, `coverageOnly` is always empty
and the operator warning is unreachable. The commit message asserts the opposite.

**The 6, named** — and every one of them is **ABSENT from production** (measured; production
holds 51 skills, all `active`, none of them canonical corpus skills):

| skill | mechanical cases |
|---|---|
| `skill_order_picking_and_packing` | 1 |
| `skill_punching_machine_operation` | 1 |
| `skill_structural_fit_up_and_tacking` | 1 |
| `skill_pipe_support_and_clamping` | 1 |
| `skill_suspension_and_steering_repair` | 1 |
| `skill_earthing_and_bonding` | 2 |

**So the stricter reading blocks zero live promotions today.** It changes the pipeline, not the
data — and its concrete price is *six reviewed cases*, one per skill, which is a bounded trainer
task rather than an open-ended one.

| | change | cost | effect |
|---|---|---|---|
| **E1 — the spec is right** | `reviewStatusOf(c) === "reviewed"` | two words + tests | a mechanical case is tautological (the query is the skill's own alias) and proves nothing about retrieval, so it stops unlocking promotion. **6 skills need one reviewed case each** |
| **E2 — the code is right** | fix the SPEC prose and the `#953` commit claim | documentation only | a mechanical case does prove **reachability**, which may be all the gate ever asked for. Zero behaviour change; removes a live contradiction between spec and code |
| **E3 — make it explicit** | keep both sets; require `--waive EVAL_COVERED` for a mechanical-only skill | small — the waiver path and the warning already exist and are currently unreachable | the decision moves to the operator, per promotion, and is recorded in the report |

**Decides:** eval owner. **Engineering position:** none on E1 vs E2 — both are defensible — but
whichever is chosen, the `#953` commit message and the C5 prose must stop disagreeing with the
code, and E3 is the only option that leaves a record of the judgement per promotion.

---

## 6. `#1027` — needs a frontend owner, not a taxonomy decision

**What it is.** `match-feed.service.ts:97` sets `trade_key: row.matchedSkillId` — the raw id. The
worker app string-interpolates that field straight into a card subtitle
(`applied_jobs_screen.dart:181`, `'${job.tradeKey} · $place'`) on the stated assumption that
*"V1 feed postings carry no trade_key"*, which the API contradicts. With `MATCH_V1_ENABLED` on, a
worker would see the literal string `mskill_mig_welder`.

**Investigated, and the backend is not the bug.** Emptying `trade_key` under V1 would delete an
intentional property, pinned by a test that says so in as many words —
`match-feed.service.test.ts:277-287`: *"the id still reaches the audit trail, so the bad row is
findable"*. No backend PR was written; the issue was updated with the finding instead.

**Exposure today, measured:** `MATCH_V1_ENABLED` is **off**, `job_reach` holds **4 rows**, and
**0** of them carry a welding skill. No worker can see a raw id right now. The label
(`matched_skill_label`) is already on the same card, so nothing is missing from the payload —
the two sides simply disagree about what `trade_key` contains under V1.

| | change | owner | cost |
|---|---|---|---|
| **F1 — the app renders `matched_skill_label`, not `trade_key`** | one widget | Frontend Platform | smallest; no API change, no version skew |
| **F2 — the API adds a display-safe field and the app switches** | contract + app | Backend, then Frontend | two PRs and a skew window, for a field the payload already carries |
| **F3 — the API stops sending the raw id under V1** | service + test | Backend | contradicts the existing test's stated intent; loses the audit-trail property |

**Ownership.** Per `CLAUDE.md` §5/§6 this is Frontend Platform — **Rishi**. Backend work on it is
complete. `#1027` needs an owner assigned; it needs no taxonomy decision and should not wait on
one.

---

## Summary — who decides what

| # | item | decider | blocked on | cost of deciding wrong, today |
|---|---|---|---|---|
| 1 | `cnc-programming` A/B/C | taxonomy owner | — | 0 live rows; corpus + Path B aliases only |
| 2 | TD-07 remedy T1–T4 | taxonomy + product (T1) | — | **0 welding rows exist**; a backfill once the cohort arrives |
| 3 | OIE canonicalization | product: *should it canonicalize at all?* | — | 0 rows carry `job_domain_id`; fully observable in the shadow |
| 4 | TD-01 seed timing | taxonomy owner | S3-A not dated | seeding creates Path A behaviour where there is none |
| 5 | `EVAL_COVERED` E1/E2/E3 | eval owner | — | 0 live promotions; 6 trainer cases if E1 |
| 6 | `#1027` | assign a frontend owner | — | 0 workers exposed (`MATCH_V1_ENABLED` off) |

Every one of the six is at its cheapest right now, for the same reason: **the canonical taxonomy
is schema without data, and the match spine holds 6 worker-skill rows and 4 reach rows.** That
window closes at the first seed.

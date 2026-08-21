# O1 — moving the canonicalize pass out of the branch it lives in

> **Design. Nothing here is implemented, and the OIE switch is not activated.**
>
> Owner instruction, 2026-08-21: *"O2 is now proven to be 0% effective, so treat O1 as the actual
> required implementation, not a future optional improvement. Prepare the O1 design/PR, including:
> exact canonicalization point, interaction with the persisted prior match, effect on existing
> profiles, rollback strategy, evaluation/shadow measurement before activation. Don't activate
> the OIE switch yet."*

---

## The measurement that decides this

`db:report:oie-canonicalize-coverage`, production, 2026-08-21. The report gained an **O1
projection** for this design: it asks the OIE branch the same three questions it already asked
the canonicalizing one, from the same SQL and the same `$1` status list, so the two numbers are
comparable rather than merely adjacent.

| | sessions |
|---|---|
| canonicalizing branch (empty answer map) | **54** — carrying a pin: **0** |
| OIE branch (has an answer map) | **48** — carrying a pin: **35** |
| extraction jobs with no session at all | **18** |
| **O2 coverage** | **0.00%** |
| **O1 would add** | **35 sessions — 29.17% of all extractions** |
| reachable by neither | 85 |

Read the middle column again. **Of the 48 OIE sessions, 35 carry a pin; all 35 are `matched`; all
35 point at a domain that is still selectable and active.** Not one is lost to an unmatched status
or a dead domain — the loss rate on the OIE branch is *zero*. And on the other branch, the one
that actually canonicalizes, **not a single session has a pin at all**.

Every usable occupation pin in this database is on the branch that never canonicalizes. That is
not a partial overlap that O2 happened to miss; the two populations are disjoint and the pins are
entirely on one side. **O2 was the right way to find that out and it found that it covers
nothing.**

The two branches are partitioned by `answer_map` empty-or-not, so O1's 35 is what it **adds** —
there is no overlap term to subtract, and a test pins that reasoning rather than the arithmetic.

---

## 1. The exact canonicalization point

### Where it is now

```
apps/api  profile-extraction.processor.ts
  answerMap.length === 0  ──► /profile/extract ──► routers/profile.py:255
                                                     if settings.skill_canonicalize_enabled:
                                                        canonicalize_labels(labels, …, job_domain_id)
  answerMap.length  >  0  ──► /profile/parse   ──► no canonicalization, by design
```

The pass is **not** structurally tied to `/profile/extract`. `canonicalize_labels` in
`app/ai/canonicalize.py` is already a free function with a clean signature:

```python
canonicalize_labels(labels, domain_id, store, settings, *, lang="en", job_domain_id=None)
    -> (assigned_skill_ids, unresolved_labels, embed_cost_records)
```

What is branch-bound is its **call site**: 60-odd lines inline in the `/profile/extract` handler
that assemble the labels, choose the scope, reserve spend against the ledger, and collect the
embed cost records. The OIE branch cannot reach any of it because it calls a different route.

### Where it should be — and the option to reject first

**Not inside `/profile/parse`.** The symmetric-looking fix — give parse a `job_domain_id` and run
the same block — puts an embedding fan-out inside a route with a **6-second deadline and an
`apps/api` abort at 8s** (`ai/gemini_client.py:48`). The pass is N embeds over the label set; on
the OIE branch that is the projection's whole skill list. Parse would start timing out, and the
failure would land on the profiling hot path as a lost interview, not as a lost canonicalization.

**The recommendation: give the pass its own route, and have both branches call it.**

```
POST /skills/canonicalize-batch
  { labels: [...], job_domain_id?: str, domain_id?: str, lang: str }
  -> { assigned_skill_ids: [...], unresolved_labels: [...], ai_metadata: [...] }
```

- It is a thin wrapper over the function that already exists, plus the ledger reservation the
  current inline block does. **The pass itself does not change** — same `canonicalize_labels`,
  same SG-3 guarantee that only vector-assigned ids come back, same pseudonymized miss recording.
- `/skills/canonicalize` already exists and is **single-label** — it returns one
  `SkillCanonicalization`. Calling it N times is N HTTP round trips and N separate ledger
  reservations, which is why this is a new batch route rather than a loop over the old one.
- **Both branches then call it as a step**, after their own extraction returns:

```
  legacy branch:  /profile/extract (pass removed) ──► /skills/canonicalize-batch
  OIE branch:     /profile/parse   + projectProfile ──► /skills/canonicalize-batch
```

That is what "move the pass out of the branch it currently sits in" means concretely, and it is
the shape that makes the two branches *the same* rather than one of them catching up.

**The label set differs per branch, and that is the one substantive design question.** On the
legacy branch the pass sees `rich.skills + rich.controllers`. On the OIE branch the equivalent is
the output of `projectProfile(answerMap, gated.accepted, …)`. These are not the same producer and
they will not have the same distribution. **The shadow measurement below exists to characterise
that before anything is activated** — a scope that is correct and a label set that is unfamiliar
still produces a bad first result, and it would be read as a scoping failure.

### Sequencing note

This is two changes and they should be two PRs:

1. **Extract the route.** Add `/skills/canonicalize-batch`; move the legacy branch onto it;
   `/profile/extract` stops canonicalizing inline. **Behaviour-identical** — same function, same
   inputs, same flag, and the flag is off. Provable by the existing extraction suite.
2. **Wire the OIE branch to it.** Only this one changes coverage, and only when the flag is on.

Doing them together makes a control-flow change and a coverage change indistinguishable in the
same diff, on the hot profiling path. The register already says behaviour must be pinned by tests
*before* the move, not after.

---

## 2. Interaction with the persisted prior match

Two different things get called "the prior match". Both matter here and they fail differently.

### (a) The pin on *this* session — what O1 reads

`conversation_state.occupation`, written by the OIE during **this** interview. O1 uses exactly
the same `canonicalScopeForPin` predicate O2 already ships, unchanged, including its three
refusals — all of which fail closed to *no scope*, which means Path B, which means today's
behaviour:

| refusal | why |
|---|---|
| the pin is absent or unparseable | nothing to scope with |
| `match_status` is not one of the four MATCHED values | an unconfirmed guess must not narrow retrieval |
| the pin's domain is no longer `selectable`/`active` | the catalogue moved between the interview and this job |

**This is not O3.** O3 was rejected for reading the worker's *persisted* prior occupation match,
which is stale by one interview — a worker whose trade changed gets scoped to the one they no
longer have, silently. O1 reads the pin from the session being extracted. A worker who changed
trade re-interviews, gets a new pin, and is scoped to the new one. **The staleness O3 was
rejected for does not arise, and O1 must not acquire it by reaching for `worker_profiles` when
the session pin is missing** — that would be O3 wearing O1's clothes. The 13 OIE sessions with no
pin stay on Path B. That is the correct answer, not a gap.

### (b) The worker's previously-assigned skill ids — what O1 must not silently rewrite

A re-extraction for a worker who already has a profile will now canonicalize under a **different
scope** than the run that produced their current `worker_skill` rows. Path A resolves through
`job_domain_skill`; Path B through the configured legacy slug. The same label can therefore
resolve to a different id, or to an id where it previously resolved to none.

This is a real behaviour change and it is **not** a defect — it is the point. What must not
happen is that it arrives unannounced:

- The extraction write path already **replaces** the derived skill set rather than merging, so
  there is no half-old/half-new state to reason about.
- What is missing is **attribution**: nothing on `worker_skill` records which scope assigned it.
  Without that, "why did this worker's skills change" has no answer after the fact, and the
  before/after comparison the shadow needs cannot be reconstructed from the database.
- **Recommendation:** the shadow (§5) runs off `ai_call_traces` and the report rather than a new
  column, so no migration is required to *measure* this. If O1 is activated, a provenance column
  on `worker_skill` becomes worth its cost — raised here, deliberately not designed here.

---

## 3. Effect on existing profiles

**None, until three separate things are all true.**

| gate | state today |
|---|---|
| `skill_canonicalize_enabled` | **off** in production, and this design does not change it |
| a caller populating `job_domain_id` | O2 does, for 0 sessions; O1 would, for 35 |
| the worker being re-extracted | only a new extraction writes anything |

A profile written before O1 is never revisited. There is no backfill in this design and none is
recommended: re-canonicalizing 35 sessions' worth of existing profiles under a new scope, before
the new scope has been evaluated even once, is the change that would be hardest to explain and
hardest to undo.

⚠ **Path A resolves through `job_domain_skill`, which holds 0 edges on production today.** Until
D2 seeds it, scoping an extraction to Path A points it at an empty index: every label misses,
every miss is recorded pseudonymized in `unresolved_phrase`, and the profile keeps its raw labels.
That is a safe outcome — it is the NullSkillStore status quo — but it is not a *useful* one, and
it would read in a report as "Path A finds nothing" when the truth is "Path A has nothing".

**So the activation order is D2 first, then O1, and never the reverse.** O1 can be *built* and
*shadowed* now; activating it against an empty edge table would produce a measurement that says
the wrong thing.

---

## 4. Rollback

Deliberately three independent levers, ordered cheapest first.

| # | lever | reverses | cost |
|---|---|---|---|
| 1 | `SKILL_CANONICALIZE_ENABLED=false` | the entire pass, both branches, instantly | a config flip; already the production state |
| 2 | stop populating `job_domain_id` on the OIE branch | Path A only; Path B canonicalization continues | one field at the call site, the same shape O2's rollback has |
| 3 | revert the route extraction | the control-flow change itself | a revert of PR 1; PR 2 must be reverted first |

**Lever 2 is the one that matters** and it is why the two-PR split is not bureaucracy: with the
route extracted, "turn off Path A for the OIE branch" is the same one-field change O2 already
has, and it does not touch the branch structure. Without the split, the only way back from a bad
Path A result is a control-flow revert on the hot profiling path.

**Nothing here rolls back a write.** Profiles written while O1 was active keep their assignments;
lever 2 stops *new* ones. Reverting an assignment already written is a re-extraction, which is
the same operation as making it — see §2(b) on why the provenance column is worth having before
that question is ever asked in anger.

---

## 5. Evaluation and shadow measurement — before activation

**Three measurements, in order. None requires the flag to be on.**

### M1 — coverage projection (**done, shipped, re-runnable**)

```
pnpm --filter @badabhai/db db:report:oie-canonicalize-coverage
```

Answers *how many sessions would O1 scope, and would the scope be valid* — 35, all matched, all
on live domains. Re-run it immediately before any activation decision: it is the number that
justifies the work, and if the OIE branch's pin rate ever collapses, the design's premise goes
with it.

### M2 — label-set characterisation (**not built**)

The one genuinely unknown quantity in §1: the OIE branch's projected labels come from
`projectProfile`, not from `map_rich_to_legacy`, and nobody has compared the two distributions.
Offline and cheap:

- for the 35 scopable sessions, project the labels the OIE branch *would* send;
- report count per session, overlap with the legacy branch's vocabulary, and how many are already
  exact `skill_alias` matches under the pinned domain;
- **no provider call and no embed** — an exact-alias check is a string comparison against the
  corpus.

If a large fraction are already exact alias hits, O1's first result will be good and the pass is
mostly paying for the tail. If almost none are, the scope is right and the label set is the
problem, and that must be known *before* the first Path A number is published.

### M3 — dual-scope shadow (**not built; needs D2 first**)

The real evaluation, and the reason it is last: canonicalize the same label set under **both**
scopes and compare, without either result reaching a profile.

- Path B under the configured slug — the current behaviour, the control.
- Path A under the pinned `jd_*` — the proposal.
- Report: agreement, ids gained, ids lost, and every label that resolved under B and missed
  under A. **The losses are the finding**, not the gains — a scope that improves the average
  while dropping a skill a worker actually has is worse than no change.
- It costs embeds, so it belongs behind the same ledger reservation the pass uses, and it should
  run over a bounded sample rather than all 35 at once.

**M3 is meaningless before D2**: with 0 edges in `job_domain_skill`, Path A misses everything and
the shadow reports a 100% loss that is an artifact of an empty table.

### The activation sequence this implies

```
   PR 1  extract the route (behaviour-identical, flag off)
   PR 2  wire the OIE branch (still flag off; nothing changes)
   M2    characterise the label set                     <- can happen any time
   D2    seed + embed + promote                         <- separate owner approval
   M3    dual-scope shadow on a bounded sample
   ----  owner decision, with three measurements in hand
   flag  SKILL_CANONICALIZE_ENABLED
```

---

## What this design deliberately does not do

- **It does not activate the switch.** Not the flag, not the field.
- **It does not backfill existing profiles.**
- **It does not add the `worker_skill` provenance column.** Named in §2(b) as the thing worth
  having before an assignment is ever questioned; it is a migration and a separate decision.
- **It does not fold the pass into `/profile/parse`**, and §1 says why in terms of a measured
  deadline rather than a preference.
- **It does not reach for `worker_profiles` when a session has no pin.** That is O3, it was
  rejected for producing a wrong answer silently, and a "fallback" is exactly how it would come
  back.

## Change log

| date | what |
|---|---|
| 2026-08-21 | Written. O1 promoted from "eventual fix" to required, on the owner's ruling and on the measurement: **O2 covers 0.00%, O1 projects 35 sessions / 29.17%**, and every usable pin in the database is on the branch O2 cannot reach. `db:report:oie-canonicalize-coverage` gained the O1 projection so that claim is a command, not a paragraph. Nothing implemented; the switch is not activated. |

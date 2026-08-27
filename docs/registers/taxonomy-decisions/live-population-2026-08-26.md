# The live population, re-measured — and two things it cannot explain

**Prepared against main `960393ec` · measured 2026-08-26 · read-only · role `postgres`, `bypassrls = true`**
**Production mutation: NONE · AI spend: ₹0 · no PII selected · no historical document edited**

Reproduce: `pnpm db:audit:live-population --json=<out>`
Artifact: [`live-population-2026-08-26.json`](./live-population-2026-08-26.json) · Tests:
`live-population.test.ts` (13)

> **This is a NEW measurement, not a correction.** `worker-data-discrepancy-resolved.md`,
> `d1-runtime-path-trace.md` and `project-control.md` are unedited. Where this run disagrees with
> them, the disagreement is reported and — twice — **left unresolved rather than explained away.**

---

## Why the instrument does more than count

This programme has already been burned by a bare count. D-1 recorded 44 worker profiles; 45 were
deleted through the Supabase dashboard hours later the same day; both documents were dated
2026-08-21 and neither was wrong. The date could not separate them.

`workers` has now gone from a recorded **1** to **37**, and "37" alone cannot distinguish *people
registered*, *rows were restored*, or *the earlier count was wrong*. So every count here sits
beside the two mechanisms that can change it — `created_at` for arrivals, `_delete_forensics` for
departures — and the report says plainly when they fail to add up.

**A zero from a role without `BYPASSRLS` is not evidence.** Every table below is `FORCE ROW LEVEL
SECURITY` with no policies, so the audit refuses to run at all unless the role bypasses it.

---

## Current state

| table | 2026-08-26 | 08-21 (pre-deletion) | 08-24 (project-control) | |
|---|---:|---:|---:|---|
| `workers` | **37** | — | 1 | **moved** |
| `worker_profiles` | **22** | 44 | — | **moved** |
| `worker_skill` | **0** | 8 | 8 | **moved** |
| `job_reach` | **0** | 6 | 0 | — |
| `jobs` | **19** (17 open) | — | 25 | **moved** |
| `applications` | **28** | — | 92 | **moved** |
| `job_posting_skill` | **0** | 0 | 0 | unchanged |
| `voice_notes` | **0** | — | — | still dormant |
| `skill` | 165 — **52 active / 111 provisional / 2 deprecated** | | | |
| `skill kind='match_skill'` | 18 | | | |

**Nothing has been promoted.** 111 provisional rows, and the two deprecated ones are the
pre-existing `skill_chassis_fitting` and `skill_go_no_go_gauge_checking` crosswalks — the D-7C
seed has not run.

**The relevance chain is empty on every side**: `job_posting_skill` 0, `worker_skill` 0,
`job_reach` 0. Unchanged, and still the whole story.

---

## Arrivals and departures

```
workers created    08-21: 7   08-22: 17   08-23: 7   08-24: 3   08-25: 3     = 37
profiles created   08-21: 6   08-22:  8   08-23: 2   08-24: 3   08-25: 3     = 22
```

Every current worker arrived between 2026-08-21 and 2026-08-25 — real registration traffic, the
first sustained arrival the platform has recorded.

```
_delete_forensics   311 rows, 311 via supabase/dashboard, db_user postgres
                    latest 2026-08-21 (119 workers + 45 worker_profiles)
```

**No deletion has been recorded since 2026-08-21.**

---

## Unreconciled #1 — the recorded "1 worker [08-24]"

**31 workers already existed before 2026-08-24**, and nothing was deleted after 08-21. So the
recorded figure is not `count(*) FROM workers`.

Rather than guess, the audit enumerates the plausible predicates:

```
workers_before_0824          31
profiles_before_0824         16
workers_with_application      5
workers_with_profile         20
profiles_with_job_domain     10
predicates yielding 1:     NONE
```

**No probed reading yields 1.** The figure sits in `project-control.md` in the *"Actually used"*
column, so it may have counted engagement rather than rows — but the document carries no
`population_predicate`, and **that is exactly the gap the provenance rule was created to close.**
It predates enforcement.

> **FACT GAP, not a decision.** The figure's author is the only person who can say what it
> counted. Nothing here is changed on the strength of a guess, and a test pins
> `explained_by_arrivals: false` so a future run cannot quietly inherit an optimistic reading.

## Unreconciled #2 — jobs 25 → 19, applications 92 → 28

Both fell, and **neither has a forensic record** — because `_delete_forensics` has triggers on
`workers` and `worker_profiles` **only**:

```
tables with recorded deletions: worker_profiles, workers
```

So for `jobs` and `applications`, *"no deletions recorded"* is the **absence of a trigger**, not
the absence of a deletion. No job has been created since **2026-08-05** (17 on 06-19, 2 on 08-05),
so 19 is not recent growth — six rows left, by a route nothing observes.

**This is an observability gap, and it is the more useful half of the finding.** The forensics
table exists because a worker-count discrepancy cost three days; the same class of question about
`jobs` cannot be answered at all today.

---

## Live behaviour the summary does not mention

**10 of 22 worker profiles carry a `job_domain_id`**, matched 2026-08-21 → 08-25:

| status | layer | n |
|---|---|---:|
| `matched_lexical` | `l0_exact` | 5 |
| `matched_worker_confirmed` | — | 3 |
| `matched_lexical` | `l2_trigram` | 2 |

**Every match is lexical or worker-confirmed. The ANN layer never ran, and no profile carries an
embedding (0 of 22).** That is what makes this consistent with `DOMAIN_MATCH_ENABLED=false` rather
than a flag being ignored: the flag gates the vector path, and the lexical pre-layers are not
gated by it.

It is still **live taxonomy behaviour** — worker speech is being resolved to a `job_domain` in
production today — and *"steps 2–4 and 6–9 are not connected"* omits it. The omission is
defensible for the job side; on the worker side the resolver is running and writing.

---

## What did NOT change

No production write. No document rewritten. `SKILL_CANONICALIZE_ENABLED` (false) ·
`DOMAIN_MATCH_ENABLED` (false) · the 0.75 floor · `MATCH_SKILLS` · the bridge · every gate ·
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

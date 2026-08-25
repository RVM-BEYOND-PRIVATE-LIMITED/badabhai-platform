# ADR D-1 — Ownership and lifecycle of the attribute → match-skill bridge

**STATUS: PROPOSED — OWNER DECISION REQUIRED**
**Date 2026-08-21 · main `96fa6aba` · evidence: `d1-runtime-path-trace.md`**

---

## What this ADR is not about

It is **not** about unifying `skill_*` and `mskill_*`. The runtime trace disproved the premise
that motivated that question. The two vocabularies serve different roles, a bridge between them
already exists and already runs, and the architectural question is about **ownership and
lifecycle of that bridge** — plus whether taxonomy relationships belong on the runtime path at
all.

## Established by the trace

```
worker_profiles.skills            (attribute skill_* ids)
        ↓  ATTRIBUTE_TO_MATCH_SKILLS      packages/taxonomy/src/match-skills.ts:436
mskill_*                          (match vocabulary, 18 declared)
        ↓  profile-extraction.processor.ts:476   — LIVE, every extraction, ungated
worker_skill                      (8 rows, all match_skill)
        ↓  materialize-job-reach.ts
job_reach                         (6 rows, 1 posting)
        ↓  match-feed.repository.ts:140          — READ gated by MATCH_V1_ENABLED=false
match feed
```

Separately, and **not on this path**:

```
job_domain → job_domain_skill → skill_*      236 edges · 28 domains · 130 attribute skills
                                             0 match skills · no runtime reader
```

## The bridge is exhaustive, and its gaps are deliberate

This is the finding that reframes everything, and it corrects an earlier claim of mine that the
bridge "covers about a third".

```
SKILL_CORPUS                       49
ATTRIBUTE_TO_MATCH_SKILLS keys     49        ← exhaustive, enforced by test
  → map to []                      21        ← deliberate: attribute, never matched
  → map to ≥1 mskill               28
distinct mskill_* targets          15 of 18
```

From the source comment:

> *"EXHAUSTIVE over `SKILL_CORPUS`… a corpus id that implies nothing at posting level maps to
> `[]`. That is not padding — it forces an explicit triage decision on every new corpus skill
> (the test fails on an unmapped one)… THE EMPTY ONES ARE THE POINT. GD&T reading, tool-offset
> setting, Fanuc/Siemens/Mitsubishi control operation, micrometer usage, fixture setup,
> drilling, boring, tapping, deburring… Mapping them to a posting-level skill would reach a
> lathe hand for a programmer's vacancy on the strength of him owning a micrometer."*

So the 21 empty entries are **the safety property**, not missing work. The bridge is a curated,
tested, reviewed artifact — not a stub.

It is also already handling the false-friend risk: `skill_drainage_systems → mskill_plumber`,
`skill_welder_occupation → mskill_mig_welder`. And the seven `*_occupation` anchors are
load-bearing here (`skill_machinist_occupation → mskill_cnc_operator_general`), which
independently confirms **D-4: do not deprecate them.**

### The real gap

**The 98 growth-corpus skills D2 added are not in `SKILL_CORPUS`, so they have no bridge entry
and no triage decision — and the exhaustiveness test cannot catch that, because it only ranges
over `SKILL_CORPUS`.**

Promoting the 96 candidates would therefore create 96 `active` attribute skills that are
invisible to matching, silently, with no test failing.

That is the concrete link between Phase 9 promotion and D-1, and it is an argument for settling
this ADR **before** promotion rather than after.

---

## Question 1 — where should the mapping live?

### Option A — keep it hardcoded in `@badabhai/taxonomy`

| dimension | assessment |
|---|---|
| provenance | git history; every change has an author, a diff and a review |
| ownership | the taxonomy package; one owner, one review path |
| reviewability | **strongest available** — a mapping change is a code diff in a PR |
| versioning | package version; ships atomically with the code that reads it |
| rollback | revert the commit; deterministic |
| deployment coupling | **a mapping change requires a deploy** — the main cost |
| testability | exhaustiveness and validity are already enforced by test |
| auditability | complete |
| runtime cost | zero — an in-memory `Map`, no query on the extraction hot path |
| arbitrary-mapping risk | **low** — a bad mapping cannot land without review |
| approval | code review |
| unmapped surfacing | the exhaustiveness test fails — **but only for `SKILL_CORPUS` members** |

### Option B — move it to a database relation

| dimension | assessment |
|---|---|
| provenance | needs to be built: source, author, reason, timestamp columns |
| ownership | ambiguous unless deliberately assigned — anyone with write access |
| reviewability | **weaker unless a review workflow is built.** A row can be inserted by a runner |
| versioning | needs a scheme; today's tables mostly lack one |
| rollback | data rollback, which this project does by hand |
| deployment coupling | **removed** — the stated benefit |
| testability | can no longer be asserted statically; tests need a database |
| auditability | as good as the columns you add, and no better |
| runtime cost | a lookup per extraction, cacheable |
| arbitrary-mapping risk | **materially higher** — this is the layer that decides *which vacancies a worker is reached for*, and a wrong row silently mis-reaches real people |
| approval | needs an explicit approval mechanism, which does not exist |
| unmapped surfacing | queryable, and could cover the growth corpus too |

### Recommendation — **A, with one addition**

The stated benefit of B is removing deployment coupling. On the evidence, that benefit is small
and the cost is real:

- Mapping changes are **rare and consequential**, not routine. This is not configuration; it is
  the rule deciding which jobs a worker is shown. Coupling it to review is a feature.
- The project's existing safety posture is built on exactly this: gates that a runner cannot
  satisfy alone, evidence files a reviewer reads, `--waive` recorded in a report. A
  database-editable matching rule cuts against all of it.
- Migrations here are applied by hand, so B trades a deploy for a hand-applied migration plus a
  new approval mechanism. That is not obviously less friction.

**The addition:** extend the exhaustiveness test to cover **the promotable corpus**, not just
`SKILL_CORPUS`. That closes the real gap — 96 growth skills with no triage decision — without
moving the mapping. It is a test change, and it would make the next promotion fail loudly rather
than silently produce unmatched skills.

**Recommendation, not a decision.** If the product intent is that non-engineers should curate
matching rules, B becomes correct and the work is the approval workflow, not the table.

---

## Question 2 — what is `job_domain_skill` for?

The trace is unambiguous: **no runtime reader consults it.** It is corpus/authoring data.

```
job_domain_skill          taxonomy/corpus/authoring relationship
ATTRIBUTE_TO_MATCH_SKILLS runtime bridge into the match vocabulary
```

### Should it move onto the runtime path?

**Recommendation: no — not on the strength of Phase 9 having generated the edges.**

- Nothing today requires it. Reach is computed from `worker_skill ⋈ job_posting_skill`, both in
  the match vocabulary; the domain layer adds no information that path lacks.
- Putting it on the path would make **every generated edge a live matching rule**. The corpus
  was produced by batched LLM generation behind a quality gate — appropriate for authoring, and
  a much higher bar to clear for deciding who sees which job.
- The two layers have different revision rates and different blast radii. Collapsing them
  removes the ability to grow the corpus without touching matching, which is precisely the
  freedom that makes corpus expansion safe.

`job_domain_skill` earns a runtime role only if a **separately demonstrated product
requirement** shows the match vocabulary cannot express something users need — for example
domain-scoped disambiguation the flat vocabulary genuinely cannot represent. No such
requirement is on record.

### Consequence to state plainly

**Expanding `job_domain_skill` from 236 edges to thousands would not make the feed more
relevant.** It would enlarge authoring metadata. Any relevance gain has to come through the
match vocabulary and the bridge.

---

## Decisions required from the owner

1. **Q1 — mapping location.** Recommendation: keep it in code (A), and extend the exhaustiveness
   test to the promotable corpus. Decide otherwise if non-engineers should curate matching.
2. **Q2 — `job_domain_skill` on the runtime path.** Recommendation: no, it stays authoring
   metadata until a product requirement demonstrates otherwise.
3. **Sequencing.** Whether promotion waits for Q1. Recommendation: yes — otherwise 96 skills go
   `active` with no triage decision and nothing fails.

## Consequences of doing nothing

The bridge keeps working for the 49-skill wedge. Growth-corpus skills stay invisible to
matching whether or not they are promoted. Coverage work continues to produce data with no
runtime effect. Nothing breaks; nothing improves either.

## What was NOT changed

No gate, no baseline, no threshold, no production data, no flag. `ATTRIBUTE_TO_MATCH_SKILLS` is
untouched.

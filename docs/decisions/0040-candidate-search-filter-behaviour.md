# ADR-0040: Candidate search filter behaviour — reorder-and-count by default, strict by opt-in

- **Status:** **PROPOSED — UNSIGNED.** Owner ruling R-E1 (2026-09-05) is transcribed here; the signature slot at the foot of this file is deliberately blank. Nothing may be built from this ADR until it is signed.
- **Date:** 2026-09-05
- **Owner:** CEO / Prakash
- **Amends:** [ADR-0036](0036-matching-algorithm-v1.md) — narrowly, and only on the points named in "What this does and does not supersede" below. Every other clause of ADR-0036 stands unchanged.
- **Settles:** ruling **R7** ([RVM_TAXONOMY_WORKSHEET_2026-09.md:770-794](RVM_TAXONOMY_WORKSHEET_2026-09.md)) — option **(a)**, plus an opt-in form of option **(c)**.
- **Relates:** [ADR-0010](0010-contact-unlock-and-reveal.md) (the consent gate this ADR puts in a `WHERE` clause) · [ADR-0031](0031-account-deletion-grace-window.md) (payer-surface freeze) · [ADR-0019](0019-self-serve-payer-portal.md) (the payer surface this lands on)
- **Implemented by:** phase **E2** (`docs/agent/phases/E2_BUILD.md`)

## Context

The first paying employer needs a filterable candidate list, and the platform has none:
320 route decorators across 69 controllers in `apps/api/src` contain no candidate search,
and payer-web has no candidates page. Everything a payer can see of a worker today is
scoped to one posting they already published
([apps/api/src/payer-portal/payer-reach.controller.ts:63](../../apps/api/src/payer-portal/payer-reach.controller.ts)).

Building that surface forces a decision this codebase has deferred twice.

**The deferred decision.** A filter can *narrow* a set or *reorder* it. The taxonomy
worksheet put the question as ruling R7 and left it unsigned; engineering recommended
option (a) — *"same candidate set, same count; matching candidates lead; badge reads '14
of 62 match Fanuc.' Never scored, never ranked, never removes anyone"*
([RVM_TAXONOMY_WORKSHEET_2026-09.md:786](RVM_TAXONOMY_WORKSHEET_2026-09.md)). Phase P5 was
then briefed to build exactly that, and correctly HALTed because building it would settle
an open ruling (`docs/agent/phases/P5_BUILD.md:1`,
`docs/agent/BUILD_RULES.md:31`).

**Why the pure form of either answer is wrong here.** Reordering alone leaves a payer
scrolling a list of sixty-two to find fourteen, which is not a filter and will not be
experienced as one. Narrowing alone shows a payer an empty screen, from which the only
available inference is *there is no supply* — and at this stage of the platform that
inference is both wrong and expensive: it is the conclusion that loses the first paying
employer. Neither failure is about ranking. Both are about what a number on a screen makes
someone believe.

**Two facts that constrain any answer.**

*Coverage is uneven, and a filter cannot tell "no" from "not recorded".* The worksheet
already anticipated this in its own cost analysis of R7(a): *"A worker whose `controller`
is simply unrecorded is indistinguishable from one who does not match, so on a
sparsely-filled attribute '14 of 62' understates the real pool and reads as scarcity that
is not there."* That is measured, not hypothetical: 137 distinct attribute keys are
authored across 148 question packs, and five packs ship.

*Nobody can yet check any of this against real supply.* The workers on the live database
are testers (owner ruling R-E4, 2026-09-05), and worker data from another project has not
been scoped, let alone migrated.

## Decision

### 1. Reorder-and-count is the default

A candidate search returns **the whole eligible population**. Filters that the payer
supplies **order** the result — matches first, non-matches after, in the ordering of §5 —
and **remove nobody**. The response carries both counts, and the surface renders them as a
badge: **"14 of 62 match"**.

This is R7 option (a), and it is the default because it is the only mode in which a payer
cannot mistake a gap in our data for a gap in the labour market.

### 2. A strict filter exists, and it is opt-in and explicit

A payer may choose to narrow the set. The request carries `strict: true`; there is no
configuration, no remembered preference, and no code path in which strict becomes the
default. A payer who has not asked for strict never receives a narrowed set.

This is R7 option (c) — which engineering rejected — admitted deliberately and under one
condition, stated next. The rejection reasoning in the worksheet rested partly on a claim
about a 70-candidate floor suppressing the hot tag; that claim is false against shipped
code (`packages/reach-engine/src/ranking.ts` guarantees at least one hot worker for any
non-empty pool), and it is recorded here so that a future reader does not rediscover the
rejection and re-apply it to a ruling that has already accounted for it. The reason strict
is admitted is not that the old objection was wrong: it is that Decision 3 removes the harm
the objection was about.

### 3. The count is computed and delivered before the narrowed list renders

**This is the load-bearing clause of the ruling, and the one a builder is most likely to
drop as cosmetic.** In strict mode the payer sees **"0 of 62 match"** — never an empty
screen with no explanation of what emptied it.

Two consequences, both binding:

- The response body carries `matched` and `total` **whether or not any row is returned**.
  A strict search that matches nothing returns `{ matched: 0, total: 62, results: [] }`,
  never an empty envelope and never a 404.
- The client must render the count from that same response. A design in which the count
  arrives in a second request can show an empty list first, which is precisely the failure
  this clause exists to prevent.

The rule in one sentence: **a payer must never be able to reach a state in which the screen
is empty and the reason is not on it.**

### 4. Unrecorded is not "no", and the surface must say which it is

Every filter treats a missing value as **not excluded**, in both modes. The precedent
already ships, on the worker feed, and is to be copied rather than reinvented:

```sql
AND (:city::text IS NULL OR jp.city IS NULL OR lower(jp.city) = lower(:city::text))
```

[apps/api/src/match/match-feed.repository.ts:152-155](../../apps/api/src/match/match-feed.repository.ts),
whose stated reason is *"a job with no city/shift/pay band matches every filter rather than
vanishing from a feed it belongs in."*

For any filter over a field that can be unrecorded, the badge carries a **third number**:

> **14 match · 9 unrecorded · of 62**

Two rules follow, and both are testable:

- A filter is offered **only** for a field the searched population is actually asked about.
  Offering a `controller_brand` facet to a payer searching welders produces a number whose
  denominator is zero and whose meaning is nothing.
- The unrecorded count is **never folded into either other number**. Folding it into
  "match" overstates supply; folding it into the remainder understates it. It is a third
  fact and it is displayed as one.

### 5. The ordering, stated exactly

Within a candidate search the order is:

```
ORDER BY  filter_match DESC,        -- 1 when every supplied filter matched, else 0
          <ADR-0036 §2 rank key>    -- unchanged, in full, as the tie-break
```

`filter_match` is a **boolean computed from the payer's own request**, not a score. It has
no weight, no coefficient and nothing to tune: two candidates who both match are ordered by
ADR-0036's tuple exactly as they are everywhere else. There is no partial-match score and
no "matched 3 of 4 filters" gradient — that would be a weighted rank re-entering by the
side door, and §2 of ADR-0036 exists to make that impossible.

In strict mode `filter_match = 0` rows are excluded rather than ordered last. That is the
only behavioural difference between the modes.

### 6. Consent, `wants` and deletion state are membership, not filters

Three predicates are in the `WHERE` clause unconditionally, in both modes, and are never
exposed as a payer-facing control:

| Predicate | Source | Authority |
|---|---|---|
| `employer_sharing` consent, not revoked | `worker_consents.purposes` / `revoked_at` | ADR-0010 |
| `wants = true` on the matched skill | `worker_skill.wants` | ADR-0036 §1 |
| not pending deletion | `workers.deletion_scheduled_at IS NULL` | ADR-0031 ruling (b) |

Reorder-and-count **does not apply to these**. A worker who has not consented does not rank
lower; he is not in the population, and he is not in the denominator either. `total` counts
the eligible population, never the whole worker table.

This is the clause that makes Decision 1 safe. Without it, "we always return everyone" would
be a licence to surface a worker who declined to be surfaced.

### 7. Attributes may order; they may not gate by default

R7 is settled: an attribute **may** participate in a candidate search, as an ordering under
Decision 1 and as a strict filter under Decision 2. It still may not enter the ADR-0036 rank
key, and it still may not affect the worker feed, `job_reach`, or the per-posting candidate
list. ADR-0036:65 — *"shown on the card, never matched, never ranked"* — is amended only to
the extent of this clause, and only on the search surface defined here.

## What this does and does not supersede

**It is worth being exact, because ADR-0036 does not contain a payer-side hard filter to
supersede.** What ADR-0036 contains is a *visibility gate* (§1) and a *closed rank key*
(§2). This ADR touches the second, on one new surface, and leaves the first entirely alone.

**Superseded, narrowly:**

- **ADR-0036:61** — *"Nothing else may enter the rank"* — is amended for the candidate
  search surface only, to admit the single boolean `filter_match` of Decision 5. It is not
  amended for the worker feed, for `job_reach`, or for the per-posting candidate list.
- **ADR-0036:65** — attributes *"never matched, never ranked"* — is amended to the extent of
  Decision 7, and on this surface only.

**Explicitly NOT superseded:**

- **ADR-0036 §1**, the visibility gate. A candidate search is not a job feed; nothing here
  changes which workers see which jobs.
- **ADR-0036 §2**, the rank key itself. Its six terms, its order, its floor and its bucket
  size are untouched, and it remains the complete tie-break inside every group of Decision 5.
- **The per-posting candidate list.** `MatchCandidatesService.listForPosting` and the SQL
  behind it ([apps/api/src/match/match-feed.repository.ts:227-266](../../apps/api/src/match/match-feed.repository.ts))
  are unchanged, and `apps/api/src/match/rank-parity.test.ts` continues to pin that SQL to
  `rankKeyCompare`. Candidate **search** and the **applicants list** are two surfaces and must
  stay two.
- **ADR-0036 §7's three boost fences.** Nothing here gives money a way into any ordering.
  `filter_match` derives from the payer's filter selection alone; no plan, credit balance,
  boost or capacity value may contribute to it — and `docs/agent/BUILD_RULES.md:27` bars it
  independently.

**A change of `engine_version` is NOT triggered.** ADR-0036:75 requires a new
`engine_version` for a change to the rank key, the month bucket, the feed order or the
Related-Skills table. This ADR changes none of those: `engine_version` is stamped per
*application* at apply ([packages/db/src/schema/job.ts](../../packages/db/src/schema/job.ts),
`applications.engine_version`), and a candidate search creates no application and freezes no
snapshot. Bumping it here would burn a token reserved for a genuine rank-rule change on a
surface that does not rank anything new.

## Consequences

**A count becomes a number employers trust, and inherits the coverage beneath it.** This is
the cost the worksheet named for option (a) and it is accepted, mitigated by Decision 4's
third number rather than argued away. The mitigation is a real constraint on the UI, not a
caveat: a badge that shows two numbers where three are needed is a defect, and E2's check
brief treats it as one.

**Strict mode is hard to withdraw.** Once payers filter, removing the affordance is a
visible regression — the worksheet said this of the facet and it is at least as true of the
narrowing form. It is admitted anyway because Decision 3 removes the harm: a payer who
narrows to nothing is told what the pool was.

**Nothing here can be proven against real supply yet** (owner ruling R-E4, 2026-09-05). Every
E-phase check runs against seeded local data and says so in its own text. A first green run
on this surface is evidence that the gate is *shippable*, not that it is *demonstrated* — and
the two are told apart only by mutating a line and watching the check turn red.

**The chain has a supply prerequisite that is not in this ADR.** On `main` at the date of
writing, a completed trade form derives no `worker_skill` rows, because the only caller of
`rebuildQuietly` is the extraction processor
([apps/api/src/profiles/profile-extraction.processor.ts:501](../../apps/api/src/profiles/profile-extraction.processor.ts))
and the trade-form handover switches extraction off. PR #1425 changes that. Until it lands,
this ADR's every clause is correct and its result set is empty.

**A worker must be able to leave before the search exists.** `wants` defaults true
([packages/db/src/schema/match.ts:59](../../packages/db/src/schema/match.ts)) and
`setWants` currently throws
([apps/api/src/match/worker-skills.service.ts:157-165](../../apps/api/src/match/worker-skills.service.ts)),
so a worker made visible by this ADR would have no exit but account deletion. Owner ruling
R-E3 orders E4 ahead of E2 for that reason, and it is recorded here because it is a property
of this decision rather than of the schedule.

## Alternatives considered

**Pure reorder-and-count, no strict mode (R7 option (a) alone).** Rejected: on a pool of any
real size, "matches lead" without narrowing is not a filter, and a payer who has to scroll
past forty non-matches to see the fourteen will conclude the filter is broken.

**Pure hard filter (R7 option (c) alone).** Rejected on the ruling's own grounds: an empty
screen carries no information about *why* it is empty, and the inference a payer draws is
about supply rather than about coverage.

**Display-only attributes, status quo (R7 option (b)).** Rejected: the employer discovers the
mismatch after paying, which is the exact failure the worksheet identified as a direct hit on
the hero health metric.

**A relevance score instead of a boolean.** Rejected as the most dangerous of the options,
because it looks like the most helpful. A "matched 3 of 4" gradient is a weighted rank, it
would need weights, the weights would need tuning, and ADR-0036 §2 chose a lexicographic
tuple *"precisely so that no future config change can silently violate"* the invariants. A
boolean cannot be tuned, which is the whole of its merit.

---

```
Signed (CEO / Prakash): .......................  Date: .................
```

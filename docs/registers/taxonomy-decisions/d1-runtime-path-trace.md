# D-1 — the runtime path, traced against code and production data

**Measured 2026-08-21 · main `0f39a8af` · read-only**

Traced by following callers, not by grepping names. Every count below is a production query.

---

## Headline: the premise needs correcting

The investigation was framed as *"taxonomy terminates in a vocabulary the match engine does not
consume"*. That is true of `job_domain_skill`, and **false of the pipeline as a whole**.

The match projections are **written live, on every profile extraction, and deliberately NOT
gated on `MATCH_V1_ENABLED`** (`profile-extraction.processor.ts:474-500`):

> *"NOT gated on MATCH_V1_ENABLED, deliberately: the flag selects which SOURCE the
> feed/apply/candidate-list READ from. Writing the projections while it is off is exactly what
> makes the flip safe — flipping it on a database where nobody has been derived since the
> backfill would serve a stale feed."*

So the system is **already in shadow-write mode**. The write path runs; only the read is gated.

## The two branches

### Occupation branch — LIVE, and it has data

| transition | code | table | status |
|---|---|---|---|
| worker free text → occupation | OIE / profiling | — | **ACTIVE** |
| occupation → `job_domain` | ANN over `job_domain_alias` | `job_domain_alias` (9,121 embedded) | **ACTIVE** |
| resolved domain → profile | extraction processor | `worker_profiles.job_domain_id` | **ACTIVE — 19 of 44 profiles populated** |

`worker_profiles.job_domain_id` is **not** empty and **not** write-only in the sense of "no
data": 43% of profiles carry a resolved occupation. It is consumed by interview-layer
components. What it does **not** do is feed matching — nothing on the reach path reads it.

### Skill branch — the taxonomy side stops here

| transition | code | table | status |
|---|---|---|---|
| `job_domain` → `job_domain_skill` | corpus | 236 edges, 28 domains | **DATA ONLY** |
| `job_domain_skill` → `skill` | corpus | **130 attribute skills, 0 match skills** | **DATA ONLY** |
| job phrase → `job_posting_skill` | `job-postings.service.ts:143` | **0 rows, ever** | **FLAG-OFF** (`SKILL_CANONICALIZE_ENABLED`) |
| → `worker_profile_skill` | — | **0 rows** | **DEAD — nothing writes it** |

**No runtime path reads `job_domain_skill`.** It is corpus data with no consumer.

### Match branch — LIVE WRITE, FLAG-OFF READ

| transition | code | table | status |
|---|---|---|---|
| `worker_profiles.skills` → `worker_skill` | `profile-extraction.processor.ts:476` via `ATTRIBUTE_TO_MATCH_SKILLS` | `worker_skill` — **8 rows, 6 workers, all `mskill_*`** | **ACTIVE WRITE** |
| `worker_skill` → `job_reach` | `materialize-job-reach.ts` / `rebuildQuietly` | `job_reach` — **6 rows, 1 posting, 4 `mskill_*`** | **ACTIVE WRITE** |
| `job_reach` → feed | `match-feed.repository.ts:140` | — | **BUILT, READ FLAG-OFF** |
| `job_reach` → apply gate | `match-apply.service.ts` | — | **BUILT, READ FLAG-OFF** |
| feed → worker | `applications.repository.ts` `findOpenJobs` | `jobs` | **ACTIVE — legacy chronological** |

`applications.service.ts:60` injects **both** sources; `MATCH_V1_ENABLED` (default **false**)
selects which one the read uses.

## The bridge exists — and that is the actual finding

`ATTRIBUTE_TO_MATCH_SKILLS` in `@badabhai/taxonomy`, consumed by
`packages/db/src/backfill-worker-skills.ts` and by the live extraction processor:

```
ATTRIBUTE_TO_MATCH_SKILLS entries   49
distinct mskill_* targets           15
MATCH_SKILLS declared               18
attribute skills in the corpus     147   (34 active, 111 provisional, 2 deprecated)
```

**The bridge covers 49 of 147 attribute skills — about a third.** It is a hardcoded constant in
a TypeScript package, not a database relation.

So the gap is not *"no bridge"*. It is:

1. the bridge is **hardcoded**, so extending it is a code deploy, not a data change;
2. it covers **~33%** of the attribute vocabulary, so most extracted skills reach nothing; and
3. it runs from `worker_profiles.skills` **directly** to `mskill_*` — **`job_domain_skill` is
   not on the path at all**.

That last point is why growing `job_domain_skill` from 236 to thousands would change nothing
downstream: no runtime reader consults it.

## Verified counts

| claim | verified |
|---|---|
| 130 taxonomy skills on edges vs `mskill_*` | **intersection = 0** ✓ |
| `job_domain_skill` → `mskill_*` | **0** ✓ |
| `worker_profile_skill` | **0 rows** ✓ |
| `worker_skill` is `mskill_*` only | ✓ 8 rows, 5 distinct, all `match_skill` |
| `job_reach` | 6 rows / 6 workers / **1 posting** / 4 `mskill_*` |
| `job_posting_skill` | **0 rows** ✓ |
| `MATCH_V1_ENABLED` | **false** ✓ |
| feed consumes `job_reach`? | **only when the flag is on**; today legacy chronological |
| `worker_profiles.job_domain_id` | **19 of 44 populated** — *not* empty |

## Why `worker_skill` has 8 rows after 223 extractions

Not a broken write path — the write path runs on every extraction and is retry-safe. The rows
are scarce because the hardcoded bridge maps only a third of the attribute vocabulary, and the
skills real extractions produce mostly fall outside it.

`job_reach` covering **1 posting** compounds it: reach is the cross product of derived worker
skills and published postings' skills, and `job_posting_skill` is empty because canonicalization
is off.

## What this means for D-1

The decision is **not** "should these vocabularies be connected" — they already are, by
`ATTRIBUTE_TO_MATCH_SKILLS`. The decision is **where that mapping should live and who owns it**:

- a hardcoded constant covering 33%, extended by deploy; or
- a database relation, extended by data with provenance and review.

And separately: **should `job_domain_skill` ever be on the runtime path**, or does it remain
corpus metadata that informs authoring rather than serving requests?

Those are the questions the ADR must put. **This document does not answer them.**

## Status vocabulary used

`ACTIVE` production traffic flows through it · `ACTIVE WRITE` writes run, reads gated ·
`BUILT` code exists, not routed · `FLAG-OFF` gated off · `DEAD` nothing reads or writes ·
`DATA ONLY` rows exist, no runtime consumer

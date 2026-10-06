# ADR-0036: Matching Algorithm V1 — tiered visibility + lexicographic rank, replacing weighted RANK

- **Status:** Accepted — owner ruling 2026-07-31 ([team-decisions.md](../registers/team-decisions.md), "Release endgame: eight owner rulings").
- **Date:** 2026-07-31
- **Source of truth:** *BadaBhai — Matching Algorithm V1* (2026-07-30, `engine_version: v1.0`), ratified alongside the MASTER CONTEXT 2026-07-30 release plan.
- **Supersedes:** the **ranking half** of [ADR-0011](0011-reach-feed-serving.md) / [ADR-0015](0015-reach-feed-on-real-jobs.md) (feed serving) and **all of** [ADR-0033](0033-rank-skills-overlap-factor.md) (the skills-overlap factor and the weight ledger it pinned). The 2026-06-19 CEO weight lock that ADR-0033 implemented — Trade 35 / Location 20 / Skills 15 / Experience 15 / Salary 10 / Availability 5 — is **retired**: V1 has no weights at all, so there is nothing left for that ledger to govern.
- **Relates:** [ADR-0030](0030-embedding-skill-canonicalization.md) (the skill vocabulary and canonicalization pipeline — **kept**, and repurposed: its corpus becomes V1's display-only "attributes") · [ADR-0009](0009-alpha-swipe-to-apply-seeded-jobs.md) (swipe-to-apply, whose `applications` table gains the rank snapshot) · [ADR-0013](0013-monetization-and-config-driven-pricing-engine.md) (boost pricing) · [ADR-0016](0016-payer-hiring-capacity.md) (quotas — V1 ships with `applicant_quota: off`) · TD37 (the two-job-entity split, resolved here in the serving direction) · TD42 (inert boost, retired here).

## Context

Three facts, established by a code audit at HEAD `22f78f2` on 2026-07-31, forced this decision.

**The production worker feed has never been ranked.** `GET /feed` — the endpoint the Flutter app actually calls — is `ORDER BY jobs.created_at ASC` and emits `feed.shown` with a hard-coded `score: 0, hot: false`. The weighted engine has always served a different, ops-only surface (`GET /reach/workers/:id/feed`). So "replacing the ranking engine" is not a migration of live behaviour; for workers it is the arrival of ranking, and for payers it is a change of ordering on a list nobody has bought from at volume yet.

**A payer-posted job cannot reach a worker at all.** The feed reads `jobs` (seeded alpha fixtures); payer posts land in `job_postings`; there is no FK, no join, no ETL between them (TD37, documented as deliberate). The ADR-0035 job-posting chat that shipped in PR #524 made this worse by adding a higher-throughput producer to the orphaned table. This is step one of the product and it was severed.

**The weighted model is not what the business asked for.** The V1 document specifies a fundamentally different shape: two levels (Industry, Skill) instead of four; a flat curated Related-Skills table owned by RVM instructors instead of an embedding-derived adjacency; a hard visibility gate instead of sort-never-block; and a lexicographic sort tuple with *no weight, no coefficient, no blend* — chosen precisely so that "neither can be broken by tuning, and no future config change can silently violate them."

Those two models cannot coexist on one surface. A weighted score and a lexicographic tuple disagree about the answer, and keeping both means maintaining two definitions of "who is best" and eventually shipping the wrong one.

## Decision

Adopt Matching Algorithm V1 as the single matching layer for both surfaces — the worker feed and the company's paid candidate list — and retire the weighted engine.

### 1. Visibility is a gate, not a score

```
SHOW job TO worker  IFF  worker.skills ∩ job.reach_skills ≠ ∅  AND  worker.wants[matched skill]
where job.reach_skills = job.skills ∪ related(job.skills) ⊖ the company's unticks
```

Two conditions, nothing else. Breadth belongs to the company: the posting form pre-ticks the curated related skills and shows a live reach count, and the company unticks what it does not want. The platform never silently widens past the curated relations. Nothing is hidden by a score, because at this layer there is no score.

This replaces **sort-never-block**, the ADR-0006 invariant that the current engine enforces structurally and asserts in `reach.invariants.test.ts` (output length always equals pool length). That invariant is retired deliberately, not by accident: V1's answer to "don't hide people" is that ranking never removes anyone *from a list they qualified for*, while visibility is an explicit, company-controlled, auditable gate.

### 2. Rank is a lexicographic tuple, with one floor

```
RANK KEY = ( effective_tier ASC, skill_months DESC, industry_months DESC,
             last_worked_at DESC NULLS LAST, created_at DESC, stable_hash ASC )
```

- `match_tier` is 1 when the worker holds a **posted** skill, 2 when only a **related** one. Best tier wins when he holds both.
- `skill_months` is months in the skill he matched on — the exact skill's months even when a related skill has more (worked example E6). Bucketed to 6 months: no false precision on a number a man estimated.
- `industry_months` is total calendar months in the job's industry, interval-merged, clamped to at least `skill_months` (E8/E9).
- `stable_hash` is the application id — a list that reorders between page loads looks broken to someone who just paid.

**`effective_tier` is the owner's E3 ruling.** Under strict tier dominance the document's own worked example produces a man with six months on a VMC outranking a man with ten years on a CNC lathe — which the document flagged as "the most consequential decision left in V1" and asked to be ruled on. The ruling (2026-07-31) is **tier-with-floor at 36 months**:

```
effective_tier = (match_tier > 1 AND skill_months >= tier_floor_months) ? 1 : match_tier
```

A related-skill worker with three or more years enters tier-1 ordering and then competes on skill months like everyone else. `tier_floor_months` is configuration (default 36), not a constant, and the raw `match_tier` is still carried through to the UI so a related-skill candidate is always badged as such (E18) — the company opted into that breadth and should see plainly what it is looking at before spending ₹40.

The two governing invariants survive in modified form and are release-gated by automated tests:

- **A (with floor):** a posted-skill worker outranks a related-only worker *unless* the related worker has cleared the floor.
- **B (unchanged, structural):** industry months can never promote a worker above another with more months in the matched skill. Industry speaks only when skill months are level.

Nothing else may enter the rank — not education, age, gender, caste, religion, RVM affiliation, attributes, or money.

### 3. Attributes are display-only

V1's "Skill" is what a company posts a job for (CNC Turner, VMC Operator) — role-level. The ADR-0030 skill corpus is operation-level (turning, Fanuc, GD&T, tool-offset setting), which is exactly what V1 calls an **Attribute**: shown on the card, never matched, never ranked.

Rather than rebuild the vocabulary, we mint a role-level `mskill_*` id space as new rows in the existing `skill` table, distinguished by a `kind` column, and mark the existing corpus `kind='attribute'`. ADR-0030's canonicalization pipeline is untouched and keeps its job — resolving worker phrases to corpus ids — with three deterministic checked-in bridge maps carrying those ids, plus `canonical_role_id` and `trade_key`, into the match vocabulary. The corpus entries that are pure attributes map to nothing, deliberately.

### 4. Everything is computed on write

Every read is an indexed sort. A worker's profile write derives his `worker_skill` rows and rebuilds his industry tenure; publishing a job materializes its entire reach set into `job_reach` in one `INSERT..SELECT` with `MIN()` for best-tier-wins; the feed is a covering-index join; the candidate list is a single indexed sort over `applications`.

### 5. Store the inputs, never a score

`applications` gains `match_tier`, `skill_months`, `industry_months`, `last_worked_at`, and `engine_version`, snapshotted at apply and frozen (E16). This is the document's only irreversible decision: *"you can replay every historical list under any future rule and check whether it would have ranked the Kept candidates higher. History not captured on day one is gone permanently."* Every application records the engine version that ranked it, and any change to the rank key, the bucket size, the feed order, or the Related-Skills table requires a new `engine_version`, CEO sign-off, and its own ADR.

### 6. `job_postings` becomes the served entity

The worker feed reads `job_reach ⋈ job_postings`. The legacy `jobs` table retires from the worker path; its open rows are converted to postings at cutover so the feed is never empty at flip, and existing `applications` keep pointing at the now-closed `jobs` rows untouched (invariant 8 — history is never rewritten). This resolves TD37 in the serving direction. Collapsing the tables entirely remains post-launch debt.

### 7. Boost is wired, repriced, and fenced

Boost has been purchasable and ranking-inert since it shipped (TD42, proven by a CI test). It now lifts a boosted job in the worker feed — `ORDER BY (boosted_until > now()) DESC, published_at DESC` — and nothing else. Three fences, each a release-gated test replacing the old BOOST-INERT suite:

- Boost **never adds a job that failed the skill gate**. It permutes order within what the worker already qualified for.
- Boost **never touches the company's candidate list**. Money orders jobs for workers; it never orders workers for money.
- Boost is **supply-gated**: it cannot be sold when the posting's reach is below a floor. Selling a boost into a thin trade costs the ₹999 and the renewal behind it.

Repriced to ₹499 / ₹999 / ₹1,799 for 7 / 15 / 30 days, retiring the ₹1,200-for-2-days SKU from the offered catalog while keeping it resolvable for historical receipts.

### 8. Configuration, never code

Nine values live in a `match_config` table (the proven `pricing_catalog` pattern: one active Zod-validated JSONB row, fail-closed to typed defaults): `engine_version`, `month_bucket`, `max_skills_per_posting`, `related_skills_default`, `max_consecutive_same_company`, `applicant_quota`, `tier_floor_months`, `free_unlock_credits`, `boost_supply_floor`. One env var, `MATCH_V1_ENABLED`, gates the cutover — that is a deploy switch, not tuning.

## Consequences

**PACE retires with the weighted engine.** `pace.service.ts` counts supply as `rankWorkersForJob(...).filter(r => r.hot)`, and `hot` does not exist in V1. Its auto-widening also contradicts V1's rule that a company's approved reach set is frozen (ops may widen, expiring and audited; the system may not). Its three jobs are replaced: the pre-pay zero-reach warning (E13 — never take money for a posting into a void), the nobody-wants ops alert (E12), and the audited ops-widen action. **This is flagged for explicit owner acknowledgement.**

**`feed.shown` gets a v2 payload.** `score` and `hot` no longer exist; `match_tier` and `boosted` do. Per invariant 8 the v1 payload is versioned, never mutated — the shipped shape stays in the registry as history, and the offline LEARN corpus will contain both regimes across the cutover boundary.

**`packages/reach-learn` retires.** It consumes `scoreWorkerForJob` and calibrates weights that no longer exist. It has never influenced the live path (ADR-0017), so nothing user-facing changes. Re-deriving a learn layer against V1's inputs is future work with its own ADR.

**The locked tests die and are replaced, not deleted.** `no-skills-in-rank.test.ts` pins the exact weight ledger; the GOLDEN regression pins exact float scores; `reach.invariants.test.ts` pins sort-never-block. All three assert things V1 contradicts. They are replaced by a release-gate suite in `packages/match-engine`: invariants A-with-floor and B, stable sort, the three boost fences, the eighteen worked examples E1–E18 as a data-driven table, a golden replay over stored application snapshots, and a static purity scanner (no clocks, no randomness, no embeddings, and — the new one — **no weight ledger**).

**Coarse history at launch.** Per the owner ruling, `worker_skill` rows are derived from the existing extraction: months come from total experience bucketed to 6, `wants` defaults true, `last_worked_at` is null (E4's duration-unknown semantics — last within tier, never dropped). The interview does not lengthen. The schema and the snapshot are shaped for per-stint history, so enriching extraction later is a data change, not a rewrite. Consequence to accept honestly: at launch `skill_months` does not discriminate between two skills of the same worker, so within-tier ordering leans on industry tenure and recency more than the document's worked examples imply.

**One open product/privacy question.** V1's max-2-consecutive-cards-per-company rule implies company identity is visible on the worker card. Whether `org_label` renders there needs a security review sign-off before the feed ships.

**Never sell the ranking as prediction.** No pre-hire experience measure reliably predicts who performs or who stays. The claim we can defend is the gate — *"everyone in this list has actually done this work"* — and that claim is true. *"Our AI finds you the best worker"* is not, and this ADR is the reason it is not: the LLM extracts phrases; it never ranks, filters, or rejects (invariant #4, unchanged).

## Alternatives considered

**Keep the weighted engine, defer V1.** Rejected by the owner: the ratified document set is the source of truth through release, and the weighted ledger is what V1 was written to replace.

**Hybrid — V1 for the feed, weighted for the payer list.** Rejected: two definitions of "best", a permanent reconciliation burden, and V1's application snapshot columns would be written but half-unread.

**Rewrite `packages/reach-engine` in place.** Rejected in favour of a new `packages/match-engine`. In-place means deleting the locked tests, migrating every consumer, and cutting over both surfaces in one atomic change against a production database with no staging. A new package lets V1 land, be release-gate-tested, and take consumers one at a time behind `MATCH_V1_ENABLED`, with the old engine deleted in a separate retirement change once the cutover is verified.

## Addendum (2026-09-29) — `role_kind`: a posting's display role, never a match input

**Owner ruling 2026-09-29** (web-redesign Phase 2). The 21 declared worker-side roles
(`TRADE_FORM_KINDS_ALL` in `@badabhai/types`) become selectable on job postings, as an additive,
nullable `role_kind` column on BOTH `job_postings` and the legacy `jobs` table (migration `0131`),
closed by a NULL-tolerant CHECK over the 21. This reverses the recommendation in
[E_CHAIN_DESIGN_2026-09 §7 Q1](E_CHAIN_DESIGN_2026-09.md) *only* in the narrow sense below — it
does not add a second match vocabulary.

What this addendum pins, so §3 above stays true:

- **Display / classification only.** `role_kind` is the payer's picker value: it labels the
  posting in the payer portal and draws the role line on the card preview. It is **never a match
  or rank input** — not a visibility input, not a rank-tuple key, not a tie-break. `match_skill_ids`
  (and the server-resolved `reach_skill_ids`) remain the **only** things a posting is matched on,
  and the posted match skill is still "the role" for matching purposes. Nothing derives a
  `mskill_*` id, a reach set or a relation from `role_kind`, and `job.updated` / `job_posting.updated`
  report it under its own `role_kind` key, never folded into `match_skills`.
- **`job_domain_id` stays unwritten.** `role_kind` is not mapped to a `jd_*` domain and does not
  populate `job_postings.job_domain_id`; that column keeps its 0076 meaning and its NULL.
- **The agency job keeps `trade_key`.** On `jobs`, `trade_key` (15 trade keys) stays the
  classifier the conversion bridge and the agency flow use; `role_kind` (21 roles) sits beside it
  as the display role and is never inferred from it.
- **No worker read carries it this phase** — see the ADR-0024 addendum of the same date (#1823). _(Superseded 2026-10-05 for the feed card and job detail, as art only — see the addendum below.)_
- **A chat-published posting leaves it NULL** — the interview does not ask for a role.
- **Skills are the owner's follow-up, not this change.** Not every one of the 21 roles has a
  counterpart in the V1 match vocabulary, so a posting for such a role can be classified but
  reaches workers only through whichever match skill the payer picks (or nobody, if none fits).
  Measured 2026-09-29 against `packages/taxonomy/src/match-skills.ts` (18 `mskill_*` ids): 8 roles
  have a same-named or directly equivalent match skill (`cnc_turner`, `vmc_milling`,
  `cnc_grinding`, `cam_programmer`, `cad_draughtsman`→`mskill_designer`,
  `welder`→arc/MIG/TIG, `fitter`, `quality_inspector`); the other 13 — all five polymer roles
  among them — have none. No `mskill_*` id is minted here: the owner will handle the skills
  separately, later.

Labels live in `JOB_ROLE_LABELS` (`@badabhai/types`), copied from each role descriptor's
`displayName`/`cluster` and pinned by `apps/api/src/profiling/roles/job-role-labels.parity.test.ts`.

## Addendum (2026-10-05) — `role_kind` reaches the worker card, as art only

**Owner approval 2026-10-05** ("Go", W3-BE, investor demo). This reverses ONE line of the
2026-09-29 addendum above, "No worker read carries it this phase": `GET /feed` (`FeedItem` and
`MatchFeedItem`) and the worker job detail `GET /jobs/:jobId` now return an additive `role_kind`
key. The worker card keys a role illustration on it. The field side of the ruling is the
[ADR-0024 addendum](0024-worker-visible-job-fields-pii.md) of the same date. `GET /jobs/search`
does not return it.

Every other point the 2026-09-29 addendum pins still holds, unchanged:

- **Display only.** It is never a match, rank or visibility input: not a rank-tuple key, not a
  tie-break and not a feed filter. Every worker read projects it in the SELECT list only, and the
  repository tests pin it out of each WHERE and ORDER BY. `match_skill_ids` / `reach_skill_ids`
  remain the only match inputs.
- **Not folded into `match_skills`.** No `mskill_*` id, reach set or relation is derived from it.
  It is not written into `trade_key`, which stays `""` on a posting card. `job_domain_id` stays
  unwritten.
- **NULL stays NULL.** There is no default, inference or backfill. On the way out, a value outside
  the 21 declared kinds fails closed to `null` (`apps/api/src/common/worker-role-kind.ts`).
- **No event change.** `feed.shown` / `feed.shown_v2` payloads do not carry it.

The text above is not rewritten.

## Addendum (2026-10-01) — an owner-signed interim deviation from §6 and §8 (ADR-0049)

[ADR-0049](0049-interim-union-feed.md) (#1823) lets company `job_postings` reach the **legacy**
worker feed while `MATCH_V1_ENABLED` is off. They are merged with the `jobs` arm, behind a second
feed-source env var, `FEED_POSTINGS_UNION_ENABLED`. For an interim, that departs from §6 (the
legacy `jobs` table retires from the worker path) and §8 (one env var gates the feed source).
The decisions were taken and ADR-0049 signed on 2026-10-01 by Divyanshu (Backend Platform).

It does not change V1. The flag is ignored when `MATCH_V1_ENABLED` is on. The arm's visibility
reads match inputs only (`reach_skill_ids`, never `role_kind`; the 2026-09-29 addendum holds).
The arm, its apply/skip branch and the flag are deleted by this ADR's retirement change
(ADR-0049 §8, TD152, #1904). The text above is not rewritten.

# The lifecycle of a missing skill — traced, measured, and where it stops

> **Read-only. Prepared against `cc3ce36e` · measured 2026-08-26 UTC.**
> **Production mutations: NONE · AI spend: ₹0 · no skill, alias, edge or flag was created or changed.**
>
> Runner: `pnpm db:audit:skill-lifecycle` · Model: `packages/db/src/skill-lifecycle.ts`
> Writer scan: `packages/db/src/lifecycle-writer-scan.ts` · Tests: `skill-lifecycle.test.ts` (21)
> Machine-readable: [`skill-lifecycle-2026-08-26.json`](./skill-lifecycle-2026-08-26.json)
>
> Companion, not superseded: [`job-domain-alias-skill-alias-coverage-2026-08-21.md`](./job-domain-alias-skill-alias-coverage-2026-08-21.md)
> answered *whether the two vocabularies should meet*. This answers *how either one grows*.

---

## 0. The six questions, answered

| # | question | answer |
|---|---|---|
| 1 | How are new `skill_alias` rows created today? | By **eight offline runners**, four of which insert. Not one is on a request path. Every route to a *new phrase* passes a human commit first. |
| 2 | What happens to an observed phrase with no alias? | Skill scope → a pseudonymized `unresolved_phrase` row + a `skill.phrase_unresolved` event; the phrase survives as a **display-only label**, never matchable. Occupation scope → the same, via `IdentifyService`. **Nothing else happens automatically, ever.** |
| 3 | Can `db:mine:aliases` operate against the live population? | **It can now — and it could not before today.** The runner never loaded the repository-root `.env`, so it threw `DATABASE_URL is not set` for its whole life. Fixed; first real run below. |
| 4 | How are new canonical skills proposed and approved? | Three ways, all ending in a git commit: hand-authored `SKILL_CORPUS`, a model-drafted batch through two gates, or a growth-loop proposal ratified in `wedge-aliases.ts`. Promotion from `provisional` to `active` is a separate 8-gate runner. |
| 5 | Can a `job_domain_alias` create or populate `skill_alias`/`skill`? | **No, and it is not merely unimplemented — it is unexpressible.** No foreign key, and no file in `packages/db/src` both queries the occupation alias vocabulary and writes the skill vocabulary. Asserted by a test that re-derives the set. |
| 6 | Is an ingestion path missing? | **Yes — one, and it is specific.** See §8. It is not the alias corpus. |

---

## 1. The spine, measured

All counts `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, role `postgres`, `rolbypassrls = true`
(a zero from a non-bypassing role would be a permission artifact, not a measurement).

```
occupation catalogue               3885 /  4071   selectable + active
occupation aliases                 5086 /  9121   is_searchable — drives the partial HNSW index
  ...embedded                      9121 /  9121   gemini-embedding-001 throughout
BRIDGE job_domain_skill              28 /  3885   domains with ANY edge          0.72 %
  ...that can answer                 19 /  3885   edge active AND skill active AND alias embedded
skill catalogue                      34 /   165   active attribute
                                                  111 provisional · 18 match_skill · 2 deprecated
skill aliases                       336          197 normalized · 336 embedded · 147 distinct skills
  ...reachable via Path B           106 /   336   legacy slug scope, 10 slugs
  ...reachable via Path A           330 /   336   job_domain_skill scope
miss queue (skill)                    7 /    47
miss queue (occupation)              40 /    47
  ...at the growth floor              0 /    47   count >= 3
mining input                        232          inbound chat messages, 14 sessions
CONSUMPTION worker_skill              0
CONSUMPTION worker_profile_skill      0
CONSUMPTION job_posting_skill         0
```

**The three zeros at the bottom are the finding that reframes the rest.** The taxonomy has 165
skills, 336 embedded aliases and 236 bridge edges, and **not one row anywhere in production
attaches a skill to a worker or to a job**. `worker_profiles.skills` is empty on all 22 profiles;
`job_postings.skill_phrases` is empty on all 8. Every gate, ceiling and floor debated in this
programme is a debate about a pipeline whose output side has never been written to.

### Composition, for reference

| object | breakdown |
|---|---|
| `job_domain` | 3,449 NCO selectable · 436 ISCO selectable · 186 non-selectable buckets |
| `job_domain_alias` | 4,644 isco08 · 4,051 nco2015 · **426 rvm** (the only vernacular source) |
| `skill` | 96 provisional-rvm (the promotion batch) · 34 active attribute · 18 `mskill_*` · 15 other provisional · 2 deprecated |
| `skill_alias` | 234 rvm · 51 onet · 39 esco · 12 nco — 214 `en`, 122 `hi` |
| `skill_alias` by cohort | 76 (07-14) + 22 (07-16) un-normalized with a legacy slug · 197 (08-20) normalized, slug NULL · 41 (08-20) un-normalized with a slug |
| committed corpora | `SKILL_CORPUS` 49 seeds / 116 aliases · `MATCH_SKILLS` 18 · `ATTRIBUTE_TO_MATCH_SKILLS` 145 keys · `TRADE_TO_MATCH_SKILL` 15/15 · `PROMOTABLE_SKILL_IDS` 96 · `WEDGE_ALIASES` 22, all ratified |
| data files | `sample-domains.jsonl` **28** · `domain-skills.jsonl` 244 · `skills.jsonl` 106 · `rvm-aliases.jsonl` 571 · `nco2015.jsonl` 3,471 · `isco08.jsonl` 648 |

**All 22 ratified wedge aliases are present and embedded** — re-verified row by row, which
corroborates the 2026-08-24 correction in `d6-vernacular-gap-plan.md` §2B rather than adding to it.

### Two structural facts worth stating plainly

- **`skill_alias.is_searchable` is inert.** Neither retrieval path filters on it — Path B is
  `domain_id = $1 AND s.status='active' AND sa.embedding IS NOT NULL`, Path A swaps the first
  conjunct for a `job_domain_skill` join. Every runtime `is_searchable` predicate in the codebase
  is on `job_domain_alias`, where it backs a partial HNSW index. So the 197 "elected" skill
  aliases are elected for nothing today, and the 139 un-normalized ones are fully retrievable.
- **The 18 `mskill_*` rows have zero aliases and zero edges.** They are demand-side vocabulary,
  reachable only through the hand-authored `ATTRIBUTE_TO_MATCH_SKILLS` constant. 3 of 8 job
  postings carry `match_skill_ids`; those came from a payer's selection, not from canonicalization.

---

## 2. How a `skill_alias` row comes into existence

Discovered by scanning the source tree, not by listing — the scan is re-run by the audit and by a
test, so a ninth writer makes something fail.

| table | writers found | on a request path? |
|---|---|:--:|
| `skill` | `seed-skills` · `seed-domain-skills` · `seed-match-vocabulary` · `promote-skills` · `seed-deprecations` · `s3d-rollback` | **none** |
| `skill_alias` | `seed-skills` · `seed-domain-skills` · `retag-skills` · `s3d-rollback` (insert) · `embed-skill-aliases` · `normalize-skill-aliases` · `decollide-skill-aliases` · `verify-embedding-provenance` (update) | **none** |
| `job_domain` | `seed-job-domains` | none |
| `job_domain_alias` | `seed-job-domains` · `normalize-job-domain-aliases` · `embed-job-domain-aliases` | none |
| `job_domain_skill` | **`seed-domain-skills` — one** | none |
| `unresolved_phrase` | `growth-cluster` · `growth-occupation` · `verify-unresolved-write` (rollback-only probe) | **yes** — the runtime writer is `apps/api/src/skills/skills.repository.ts`, outside the scanned package |

> The scan errs in one direction only: a writer that assembles its statement dynamically would be
> missed, so **a hit is proof and a miss is not**. It also refuses to count SQL that is merely
> *quoted* — `deprecation-seed-plan.ts` renders the statement another runner executes, and
> `audit-alias-collision-cleanup.ts` prints the de-election precisely because it will not run it.
> A first version counted both, which would have flagged the two files most careful to separate
> planning from execution. A test pins each case.

---

## 3. What happens to an observed phrase that has no alias

### Worker side

```
worker types a phrase
  → pseudonymize (fail-closed, stdlib regex, ₹0)
  → embed (gemini-embedding-001)
  → nearest skill_alias vectors IN ONE SCOPE  (Path A via job_domain_skill, or Path B via the legacy slug)
  → score >= 0.75 ?
        yes → assign the existing skill_id                         (worker_skill: 0 rows, ever)
        no  → upsert unresolved_phrase (pseudonymized) + emit skill.phrase_unresolved
              and the phrase survives ONLY as worker_profiles.skill_labels — display text
              for the résumé, explicitly never matchable
```

The whole pass sits behind `SKILL_CANONICALIZE_ENABLED`. With the flag off the route returns
`unresolved` **before** the embed, so no queue row is written either: a disabled flag and a
genuinely unmatchable phrase produce the same response body, distinguishable only in the trace.

### Job side

Identical pipeline, one shared id space. `job-postings.service.ts` canonicalizes each posting
phrase best-effort — an unreachable service or a disabled flag yields `[]` and never blocks the
write. Measured: **8 postings, 0 with skill phrases, 0 with canonical ids, 0 with a
`job_domain_id`** — so every posting that ever did canonicalize took the legacy
`cnc-machining` anchor, because that is the hardcoded fallback when the canonical domain is null.

### The queue, and why it is not a learning loop yet

| scope | rows | max `count` | embedded | window |
|---|---:|---:|---:|---|
| `occupation` | 40 | **1** | 0 | 2026-08-12 → 08-23 |
| `skill` | 7 | **2** | 0 | 2026-07-14 → 08-24 |

The growth promotion floor is **3** (`skill_growth_min_total_count`), and the skill clusterer also
needs `cluster size >= 2`. **Nothing in the queue reaches either bar**, so both loops would emit
zero proposals today — before any question of authorization or spend arises.

---

## 4. `db:mine:aliases` — it works now, and here is what it says

**It could not run at all.** `mine-chat-aliases.ts` called bare `config()` while the other 55 db
runners call `config({ path: "../../.env" })` first. `pnpm db:mine:aliases` runs with
cwd = `packages/db`, where there is no env file, so the runner threw `DATABASE_URL is not set`
before touching anything. The fault was invisible for as long as it had no input — the failure
read as *"not wired up yet"* rather than as a defect. One line, fixed here, pinned by a test.

First real run, 2026-08-26 (₹0 — the pseudonymizer is stdlib regex, no provider call):

```
fetched 232 inbound message(s)
  pseudonymizer blocked      = 0
  already resolved (covered) = 57
  unresolved (mined)         = 175
  candidates >= 3            = 29        (58 at >= 2)
```

**The generator works end to end. Its precision on this traffic is low, and the reason is
structural, not a tuning problem.** Of the 29 candidates, the occupation-bearing ones are a
handful — `vmc`, `sheet metal`, `programming`, `design`. The rest are cities (`faridabad`,
`delhi` — deliberately never masked, per the owner's DEAD LIST ruling that a city is a matching
input), qualifications (`iti`, `diploma`, `iti ya diploma`), shift vocabulary (`din shift`), and
conversational filler the `SCAFFOLD` stopword list does not yet hold (`abhi turant`, `nhi`,
`kuchh`, `ek mahine mein`).

The cause: **the inbound corpus is answers to our own interview questions, not workers naming
their trade.** A worker states their trade once, at identification, and that utterance goes down
the *occupation* path — where it is already captured as the 40 queued rows. Mining n-grams from
the rest of the transcript surfaces interview vocabulary by construction.

`vmc` at 4 distinct sessions is nonetheless a genuine catalogue gap the run found: it is a real
trade term and it resolves at neither L0 nor L1.

> The candidate file was written to a scratch directory, not committed. Mapping a phrase to a
> `job_domain_id` is the business decision the runner exists to hand to a person.

---

## 5. How a new canonical skill is proposed and approved

Three origins, one destination, and **every one of them crosses a git commit**.

```
(a) HAND-AUTHORED     engineer edits SKILL_CORPUS / wedge-aliases.ts
                        → owner sets ratified: true          [TAX-0 gate (d), not automatable]
                        → db:seed:skills --apply → db:embed:skills

(b) MODEL-DRAFTED     db:gen:domain-skills --emit-prompts   (over sample-domains.jsonl)
                        → operator runs the batch out-of-band
                        → db:gen:domain-skills --ingest
                             gate 1 validateTaxonomyCorpus   STRUCTURAL — ids, edges, ownership
                             gate 2 taxonomyQualityVerdict   SEMANTIC  — duplicate + fragmented concepts
                             BLOCK → blocked-*.jsonl, exit 1, nothing to append
                        → human commits accepted-*.jsonl
                        → db:seed:domain-skills --apply → db:embed:skills

(c) GROWTH LOOP       unresolved_phrase (count >= 3, or cluster >= 2)
                        → db:growth:cluster → review packet
                        → human pastes into wedge-aliases.ts → owner ratifies
                        → (a) from the seed step
```

The model never supplies an id: `taxonomySkillIdFor` mints it from the label as a pure function,
and an echoed `existing_skill_id` is re-validated against the catalogue rather than trusted.

**Approval to `active` is a separate step.** A seeded skill lands `provisional`; `db:promote:skills`
promotes only when all eight gates pass, fail-closed for the whole batch. 96 candidates, 0
eligible today — see [`promotion-and-activation-readiness.md`](./promotion-and-activation-readiness.md).

---

## 6. Can `job_domain_alias` create or populate the skill vocabulary?

**No.** Three independent checks, all mechanised:

1. **No foreign key.** The complete FK map over the four tables shows `skill_alias → skill` and
   `job_domain_alias → job_domain`, and the only object referencing both sides is
   `job_domain_skill`.
2. **No writer.** `crossVocabularyWriters()` looks for any file that both queries the occupation
   alias identifiers and calls `.insert(skillAliases)` or `.insert(skills)`. **Result: `[]`.**
3. **No runtime path.** `apps/` contains no insert into `skill` or `skill_alias` at all.

The two vocabularies meet at exactly one place, `job_domain_skill`, and that table is written by
one seeder from a committed file.

---

## 7. The lifecycle, as one picture

```
                          ┌──────────────────────── committed files (git) ───────────────────────┐
                          │  SKILL_CORPUS 49   wedge-aliases 22   skills.jsonl 106                │
                          │  domain-skills.jsonl 244    sample-domains.jsonl 28                   │
                          │  rvm-aliases.jsonl 571      nco2015 3471 · isco08 648                 │
                          └───────────┬──────────────────────────────────┬──────────────────────-─┘
                     db:seed:skills   │            db:seed:domain-skills │  db:seed:domains
                     db:embed:skills  │            db:embed:skills       │  db:normalize:aliases
                                      ▼                                  ▼  db:embed:domains
   ┌──────────┐   job_domain_skill  ┌──────────┐                    ┌───────────────┐
   │  skill   │◄────236 edges──────►│job_domain│◄───9,121 aliases──►│job_domain_alias│
   │   165    │   28/3885 domains   │  4,071   │   5,086 searchable └───────────────┘
   └────┬─────┘   19 can answer     └──────────┘                            ▲
        │ 336                                                               │
   ┌────▼───────┐                                                           │
   │ skill_alias│   Path A: via job_domain_skill (330 rows)                  │  L0/L1/L2/L3
   │   336      │   Path B: via legacy slug      (106 rows, 10 slugs)        │  occupation
   └────┬───────┘                                                           │  retrieval
        │  canonicalize_skill, floor 0.75, behind SKILL_CANONICALIZE_ENABLED │
        ▼                                                                    │
   ┌──────────────┐  miss   ┌──────────────────┐  miss   ┌──────────────────┐
   │ worker_skill │◄────────│ unresolved_phrase│────────►│ IdentifyService  │
   │      0       │         │  7 skill · 40 occ│         │ (worker's trade) │
   │ w_p_skill  0 │         │  max count = 2   │         └──────────────────┘
   │ jp_skill   0 │         │  floor is 3      │
   └──────────────┘         └────────┬─────────┘
                                     │  db:growth:cluster / db:growth:occupation
                                     ▼      (both refuse when NODE_ENV=production)
                            ┌──────────────────┐        ┌────────────────────┐
                            │  review packet   │───────►│  HUMAN maps it to  │
                            └──────────────────┘        │  a canonical id    │
                            ┌──────────────────┐        │  → git commit      │
     chat_messages 232 ────►│ db:mine:aliases  │───────►│  → back to the top │
     (14 sessions)          │  29 candidates   │        └────────────────────┘
                            └──────────────────┘
```

**Every arrow that returns to the committed files passes through a person.** That is by design —
CLAUDE.md §3 reserves the mapping decision for a human — but it has a consequence the diagram
makes unavoidable: **alias coverage is a function of review cadence, not of traffic.** A test
asserts it (`reachesProductAutomatically` is false for all five paths, `fullyAutomaticPaths()` is
empty), so if it ever stops being true, that becomes a failure rather than a drift.

---

## 8. The missing ingestion path

Not the alias corpus. **`job_domain_skill` — the demand-side bridge — has no ingestion path that
scales, and everything downstream inherits its ceiling.**

| | |
|---|---|
| selectable active occupations | **3,885** |
| with any skill edge | **28** (0.72 %) |
| that can answer a live Path A query | **19** (0.49 %) |
| the file those 28 come from | `sample-domains.jsonl`, **28 hand-written rows** |
| its only writer | `seed-domain-skills.ts`, from a committed batch output |
| what inheritance would add (dry run, ₹0) | **488 edges over 64 further domains → 92 total, 2.4 %** |

Three consequences, each measured:

1. **Path A canonicalization returns nothing for 99.3 % of occupations.** Not "scores below the
   floor" — returns no candidates at all, because the scope join finds no edges. No threshold
   change reaches this.
2. **Requested scopes with no vocabulary at all.** Three of the four legacy slugs that appeared in
   production canonicalization requests on 2026-08-24 — `carpentry`, `electrical`, `plumbing` —
   hold **zero `skill_alias` rows**. Those phrases were unresolvable by construction, at any
   floor, and each produced a queue row that no clustering can ever act on: one row, count 1, and
   no anchor in scope to cluster against.
3. **Inheritance is an amplifier, not a source.** 81.8 % of the 488 candidate edges descend from
   two ISCO roots, and 4 of the 28 authored roots produce all of them. It multiplies the 28-row
   file; it cannot replace it.

**What is genuinely absent is a way to author `job_domain_skill` for an occupation nobody has
hand-listed.** `db:gen:domain-skills` is capable of it — it prompts per domain and both gates are
domain-agnostic — but its input is a static 28-row file, and widening that file is a scope and
spend decision, not an engineering one. That is §10-3.

> A note against over-reading this: filling the bridge to 100 % would still emit `skill_*` ids,
> and the job feed matches on `mskill_*`. The two id spaces join only through
> `ATTRIBUTE_TO_MATCH_SKILLS`, a hand-authored constant that never consults the database. The
> bridge gap blocks **canonicalization coverage**; it is not by itself a matching win.

---

## 9. Found, and deliberately not fixed

| finding | evidence | why not fixed here |
|---|---|---|
| **Both growth loops refuse to start when `NODE_ENV=production`** — which is exactly what the only environment holding production credentials sets. `db:growth:occupation` aborts with *"refusing to run in production"*. So the learning loop has never been runnable from where it would have to run. | `growth-cluster.ts:402`, `growth-occupation.ts:164`; reproduced 2026-08-26 | Overriding `NODE_ENV` to make it pass is weakening a gate. The gate's *intent* (an ops action should be deliberate) is right; its *predicate* is the wrong one — every other guarded runner classifies the **target** from `DATABASE_URL`, not the process env. Changing it is an ops-posture decision. **§10-4.** |
| **`verify-embedding-provenance.ts` has `--apply` and no ops guard.** It writes `embedding_model` on `skill_alias` rows it judges PROVEN, and imports neither `enforceOpsGuard` nor `parseCommonCli`. | source read 2026-08-26 | A real gap, plausibly one of project-control's "4 unguarded write runners". Adding a guard changes a write runner's behaviour and belongs in its own reviewed change, not inside a lifecycle audit. |
| **Five more runners could not see the repository-root `.env`** — `audit-embedding-provenance`, `verify-path-b-parity`, `verify-embedding-provenance`, `bootstrap-admin`, `reset-admin-mfa` — all of which read `DATABASE_URL` from the environment. | scan of `packages/db/src` | The first two are read-only and **fixed here** — `db:verify:path-b-parity` now runs and independently reproduces the 106/10 Path B figures above. `verify-embedding-provenance` is deliberately **left alone** while its `--apply` is unguarded: widening credential discovery for an unguarded writer is a safety regression. The two admin runners touch PII keys and are outside this task. |
| **`sample-domains.jsonl` is not marked as a coverage bound anywhere.** Nothing in the repository states that this 28-row file sets the canonicalization scope ceiling. | §8 | It is a documentation gap this file now closes; mechanising it would mean asserting a target coverage number nobody has set. |

---

## 10. What actually remains — decisions, authorizations, facts

Nothing below is an engineering task. Each is genuinely someone else's call.

### Owner / product decisions

1. **§L-1 — Widen `sample-domains.jsonl`?** The 28 rows bound Path A to 0.72 % of the catalogue.
   Options: (a) leave it — canonicalization stays a CNC-belt feature; (b) extend to the trades
   with live worker traffic; (c) extend to all 3,885. Cost scales with (b)/(c) as a batch spend,
   quantified only once the target set is chosen. **Evidence:** §8. *No engineering work is
   blocked on this — the generator and both gates already handle any domain.*
2. **§L-2 — Is the growth floor of 3 right at this volume?** Every queued row sits at count 1 or
   2, so both loops emit nothing. Lowering it trades reviewer noise for responsiveness at launch
   volumes; the runner already exposes `--min-count`. **Do not read this as a recommendation to
   lower it** — a single utterance is as likely to be a typo as a trade, which is why 3 was chosen.
3. **§L-3 — Should `carpentry`, `electrical` and `plumbing` be scopes at all?** They were
   requested in production and hold no vocabulary. Either they get a corpus, or the caller should
   not be able to name them. Today it is neither, and every phrase in them is a guaranteed miss.

### Infrastructure facts required (not inferrable here)

4. **The `NODE_ENV=production` guard on both growth runners.** Whether it should become a
   target-classifying `enforceOpsGuard` like every other write runner, or whether ops intends to
   run them from a separate environment. Until one or the other, the learning loop cannot run.
5. **The effective `SKILL_CANONICALIZE_ENABLED` in the deployed container** — still the
   outstanding fact from the activation sequence, and this audit narrowed it without settling it:

   > **Six `skill.phrase_unresolved` events carry `metadata.environment = "production"`,
   > `service = "api"`, emitted 2026-08-24 07:58:57 → 08:14:13 UTC** — the only such events
   > outside a 2026-07-14 staging burst. The `environment` tag discriminates: 16,918 production
   > events against 6,512 development ones, with both kinds inside that same two-hour window.
   > Reaching that endpoint through `canonicalize_skill` requires the flag to be **on** for the
   > caller. The secret's value was changed at **11:30:45 UTC the same day**, ~3 h 16 m later.
   >
   > **This does not establish the deployed value, and is not treated as if it did.** The tag
   > belongs to the *api* that emitted the event, not to the *ai-service* that called it, and this
   > environment's own `DATABASE_URL` points at production — so a locally-run service would leave
   > an identical trace. The four `domain_id` values used (`cnc-machining`, `carpentry`,
   > `electrical`, `plumbing`) match **no call site in the repository**: `job-postings.service.ts`
   > and `profile.py` both send the single hardcoded `cnc-machining` anchor. Per-request slugs from
   > nowhere in the codebase is the signature of an **ad-hoc probe**, which is exactly the class of
   > evidence the standing instruction says not to infer the flag from.
   >
   > What it *does* settle: the production api's `/internal/skills/unresolved` endpoint is live and
   > writing, and the flag was on for at least one caller on 2026-08-24. **Reading the value on the
   > box remains step 1 of the activation sequence.**

### Production write authorizations

**None requested by this work.** Nothing here needs a write. The pre-existing ones —
`db:decollide:aliases`, `db:seed:deprecations`, the promotion — are unchanged.

### Paid-spend authorizations

**None requested by this work.** ₹0 spent; the mining run is regex-only, and the inheritance
projection is a dry run. The pre-existing ₹0.028128 evidence run is unchanged.

---

## What this changed in the repository

| | |
|---|---|
| `packages/db/src/skill-lifecycle.ts` | the five paths as typed data, with a validator |
| `packages/db/src/lifecycle-writer-scan.ts` | the writer set, derived from source rather than listed |
| `packages/db/src/audit-skill-lifecycle.ts` | `pnpm db:audit:skill-lifecycle` — read-only, fails closed on a stale model |
| `packages/db/src/skill-lifecycle.test.ts` | 21 tests, including both directions of the writer scan |
| `packages/db/src/mine-chat-aliases.ts` | one line: load the root `.env`, like the other 55 runners |

**Nothing was promoted. Nothing was activated. No flag was read, set or changed.**

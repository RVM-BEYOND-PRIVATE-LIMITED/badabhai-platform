# Skill Discovery Coverage Report — DRY RUN, 2026-08-26

> **Production mutation: NONE. AI spend: ₹0.** No provider was contacted; no row was written.
> Reproduce: `pnpm --filter @badabhai/db db:discover:skills --label <name>`
>
> Supersedes the first version of this report (run `sdr_20260826-113020Z`). Three classifier
> defects and one clustering defect were found and fixed between the two; the differences are
> called out in §"What changed and why".

| | |
|---|---|
| run id | `sdr_20260826-123559Z_phase5` |
| input fingerprint | `12323db49e7996291c0189a441cc01e7` |
| head lexicon | 1,089 occupation heads |
| target | `SUPABASE (remote)`, role `postgres`, `bypass_rls = true`, read-only |
| population predicate | `job_domain_alias` + `job_domain.label_en` where the domain is `selectable AND status='active'`; `unresolved_phrase WHERE status='open'` |
| corpus at measurement | 9,121 domain aliases · 4,071 domains (3,885 selectable) · 165 skills (52 active) · 336 skill aliases · 236 taxonomy edges |

---

## The headline answer

**Out of the job-domain alias population, how many are occupations only, how many carry
evidence of actual skills, how many map to existing skills, how many produce candidate
aliases, how many are genuinely missing skills, and how many need human review?**

Over **8,819 distinct normalized phrases** (from 13,054 source rows):

| disposition | phrases | share | what it means |
|---|---:|---:|---|
| `occupation_only` | **899** | 10.2% | a job title with no modifier naming work. *"Magician"*, *"Operator"*, *"मैकेनिक"*. Yields nothing. |
| `rejected_non_skill` | **252** | 2.9% | scrape prose, residual-bucket markers, contact details, over-length residue. |
| `covered_by_existing_skill` | **26** | 0.3% | already a surface form of a shipped skill. The taxonomy answers it. |
| `alias_opportunity` | **1** | 0.0% | strong equivalence to a shipped skill, different wording. |
| `new_skill_candidate` | **7,089** | 80.4% | skill-shaped, or an occupation title with a modifier, and unmatched. |
| `ambiguous` | **552** | 6.3% | no occupation head and no activity marker. A reviewer's call. |

**`new_skill_candidate` is not 7,089 missing skills, and reading it that way is the mistake this
whole pipeline exists to prevent.** Clustered and tiered:

| review tier | candidates | screens | what it is |
|---|---:|---:|---|
| **`direct`** | **82** | 74 | the phrase names an activity, or matches a shipped skill strongly. **This is where the real skills are.** |
| **`derived`** | **6,074** | 2,518 | an occupation title with a modifier. *"Dyer, Leather"* → leather dyeing *might* be a skill. |
| **`ambiguous`** | **517** | 417 | shape gives no honest signal. |
| total | **6,673** | **3,009** | |

By shape class, which is the plainest statement of the finding:

| phrase class | phrases | share |
|---|---:|---:|
| `OCCUPATION_WITH_SKILL_EVIDENCE` | 7,005 | 79.4% |
| `OCCUPATION_ONLY` | 908 | 10.3% |
| `AMBIGUOUS` | 557 | 6.3% |
| `REJECTED_NON_SKILL` | 253 | 2.9% |
| **`ACTIVITY_PHRASE`** | **96** | **1.1%** |

### In one sentence

`job_domain_alias` is a catalogue of **occupation titles**. **1.1% of distinct phrases name an
activity directly.** Everything else is a job title, or a job title from which a skill *could*
be derived — and deriving 6,074 of them is precisely the "do not create 4,000+ canonical skills"
outcome that was ruled out.

---

## The requested figures

| # | figure | measured |
|---|---|---:|
| 1 | Total job-domain aliases | **9,121** (+3,885 domain labels, +48 unresolved phrases = **13,054** source rows) |
| 2 | Unique normalized aliases | **8,819** |
| 3 | Candidate count | **6,673** |
| 4 | Cluster count | **6,688** formed (15 excluded by the attestation floor) |
| 5 | Candidates matching existing canonical skills | **27** (26 covered + 1 alias opportunity) |
| 6 | Candidates requiring new canonical skills | **6,155** suggested `create` — *of which only 82 are `direct` tier* |
| 7 | High-confidence candidates | **0** |
| 8 | Medium-confidence candidates | **1** |
| 9 | Low-confidence candidates | **6,672** |
| 10 | Likely duplicates | **954** phrases absorbed by clustering; **200** near-duplicate pairs escalated, never merged |
| 11 | Likely non-skills | **1,151** (899 occupation-only + 252 rejected) |
| 12 | Distribution by family | see below |
| 13 | Estimated review workload | **167 h** for all · **~13 h** for direct+ambiguous · **~1 h** for direct |
| 14 | Top 100 for review | `review-queue.jsonl` (priority-ordered), `review-groups.jsonl` (batched) |
| 15 | Ambiguous / unsafe semantic matches | §"Unsafe matches" |
| 16 | AI / embedding cost | **₹0 spent.** 8,762 of 8,819 phrases already carry real vectors; 57 missing ≈ **₹0.034**. Extraction ≈ **₹0.47** direct / **₹3.42** direct+ambiguous / **₹38.08** all |

### 12. Distribution by ISCO major family

| family | candidates |
|---|---:|
| Plant and Machine Operators, and Assemblers | 1,732 |
| Craft and Related Trades Workers | 1,224 |
| Technicians and Associate Professionals | 868 |
| Professionals | 828 |
| Managers | 591 |
| Service and Sales Workers | 547 |
| Clerical Support Workers | 373 |
| Elementary Occupations | 250 |
| Skilled Agricultural, Forestry and Fishery Workers | 179 |
| Armed Forces Occupations | 81 |

The two families BadaBhai serves — Plant/Machine Operators and Craft/Related Trades — are
**2,956 candidates (44%)**. The other 56% are managers, professionals, clerks and armed forces:
real occupations, and not this platform's hiring surface.

### Classifier rules that fired

| rule | phrases |
|---|---:|
| `HEAD_PLUS_EVIDENCE` | 7,005 |
| `HEAD_ONLY_NO_MODIFIER` | 908 |
| `NO_HEAD_NO_ACTIVITY` | 557 |
| `PROSE_FRAGMENT` | 196 |
| `ACTIVITY_HEADED` | 96 |
| `TOO_LONG` | 41 |
| `FORBIDDEN_CHARS` | 13 |
| `ALL_TOKENS_GENERIC` | 3 |

### Attestation breadth — the queue-cutting lever

| distinct domains a cluster appears in | clusters |
|---|---:|
| 1 | 6,239 |
| 2 | 406 |
| 3 | 24 |
| 4 | 3 |
| 5 | 1 |
| 0 (no domain scope) | 15 |

At `--attestation-floor 2` the queue is ~434 candidates, and the report states that 6,266 were
excluded. Nothing is trimmed silently.

---

## Batching — how 6,673 decisions become 3,009 screens

Clustering could not be made to shrink the queue safely (see §"Unsafe matches" (b) and (c)), so
the queue is **batched** instead. A group is a lens, not a merge: every member keeps its own row,
its own decision and its own audit trail, which is why grouping can be generous where merging
could not be.

| | |
|---|---:|
| candidates | 6,673 |
| **review screens (groups)** | **3,009** |
| candidates in a batch of 2+ | 4,694 |
| singleton groups (batching bought nothing) | 1,979 |
| largest batch | 60 |

Non-transitive **by construction**: the anchor is a pure function from one candidate to one
string, so there is no pair relation, no union, no find, and no way for a chain to form. Verified
order-independent and stable under growth over the live 6,673.

The largest batches are coherent trade questions a reviewer answers once:

```
60  metal — Plant and Machine Operators      45  products — Plant and Machine Operators
42  glass — Plant and Machine Operators      41  paper — Plant and Machine Operators
40  plant — Plant and Machine Operators      39  textile — Plant and Machine Operators
36  wood — Craft and Related Trades          33  metal — Craft and Related Trades
```

---

## Vernacular — the population this platform is for

The `direct` tier now surfaces worker language, in both scripts:

```
वेल्डिंग (welding, 3)   सिलाई (sewing, 2)   plumbing (2)   ac fitting   bijli welding
घिसाई (grinding)   चिनाई (masonry)   जोड़ाई (joining)   पुताई (whitewashing)
पेंटिंग (painting)   मिलिंग (milling)   वायरिंग (wiring)   शटरिंग (shuttering)
नानबाई (bread-making)   bearing maintenance   conduit bending
```

Two rules had been discarding all of it, and both were Latin-script by construction:

1. **The head lexicon is agent-noun morphology** (`-er`, `-or`, `-ist`, `-man`), which never
   matches Devanagari. Every Hindi phrase therefore had zero occupation heads and fell to
   `AMBIGUOUS` — `मैकेनिक` (7 candidates), `ड्राइवर` (4), `वेल्डिंग` (4) among them.
2. **`isProse` decides "starts lowercase"** via `first === first.toLowerCase()`. Devanagari is
   **unicase**: that comparison is true for every Devanagari character, so the rule reported
   "scrape residue" for **100% of Hindi input**, whatever it said.

Fixed with a measured Devanagari head list (from the 142 `lang='hi'` alias rows — all
`source='rvm'`; all 4,071 `job_domain.label_hi` are NULL) and the three Devanagari activity
nominalizers: `-िंग` loanwords, native `-ाई`, and `-ना` infinitives. Effect: ambiguous 580 → 517,
direct 57 → 82.

`-ाई` also ends दवाई (medicine) and मिठाई (sweet), and is accepted anyway: a false positive costs
one reviewer rejection, a false negative buries a real skill in a 517-row pile. Over a 142-row
population that trade is not close, and it is recorded so it can be revisited with real
rejection counts.

---

## 15. Unsafe semantic matches — the Phase-4 evidence

Four defects were found and fixed **while measuring**. All are regression-tested.

**(a) Specialization read as identity.** The inherited evidence layer graded
`strict_token_subset` as *strong* — right between two curated skill labels, wrong between an
occupation title and a skill label:

```
"customs inspector"  ->  quality inspector   subset {inspector} ⊂ {customs, inspector}   STRONG
"bicycle mechanic"   ->  fitter                                                          STRONG
"battery servicing"  ->  plumber                                                          STRONG
```

Same shape as the already-recorded `ducting_installation → plumber` and
`split_unit_installation → fitter`. **Fixed**: subset and overlap are `weak` in this module, and
`validateCandidate` refuses any `map`/`merge` suggestion without a strong match
(`WEAK_MATCH_DROVE_ACTION`). Suggested `map` fell from 120 to **1**.

**(b) Transitive collapse.** Union-find made a subset relation transitive when the relation is
not: `"wood"` ↔ `"wood metal"` ↔ `"metal"` ↔ … One cluster held **8,478 source rows, 5,706
distinct phrases and 2,814 of 3,885 domains**. **Fixed**: only identity relations merge
(`MERGE_RELATIONS`); specializations are escalated.

**(c) Consonant-skeleton over-folding.** `skeletonKey` drops interior vowels, so
`pile`/`pool`/`ply` → `pl`. One cluster contained *"pile-driver operator"*, *"swimming pool
cleaner"* and *"ply bander"*; another held *"battery assembler"* beside *"butter maker"*.
**Fixed**: the L1 skeleton is a candidate generator, not a merge decision — its own docblock says
so — and it no longer merges.

**(d) `mskill_*` leaking into the evidence.** The existing-skill index was built over the whole
`skill` table, so seven candidates were offered `mskill_quality_inspector` and
`mskill_fitter` as mapping targets. **Fixed** at four independent points: the index drops
`kind='match_skill'` rows, `validateCandidate` refuses both a match and a resolution onto one,
and two CHECK constraints refuse them in the database.

**Still escalated, never merged** (sample of 200):

```
"engin mechanical" ~ "aeronautical engin mechanical"   [strict_token_subset]
"engin mechanical" ~ "engin marine mechanical"         [strict_token_subset]
"manag manufacturing" ~ "labour manufacturing"         [strict_token_subset]
```

Genuinely undecidable from shape — is marine mechanical engineering the same competency as
mechanical engineering? — so they reach a human as a question.

---

## What the approval path found (Phase 5)

Four decisions applied to real direct-tier candidates and pushed through both shipped gates:

| decision | candidate | outcome |
|---|---|---|
| CREATE | `शटरिंग` | `skill_shuttering_erection` + 1 curated edge to `jd_nco_7115_0201` |
| ALIAS | `bijli welding` | 3 aliases onto `skill_arc_welding`, 4 pre-existing edges carried |
| REJECT | `boiling in charge` | no corpus record |
| HOLD | `composing room operatives` | no corpus record, distinguishable from a rejection |

Gates: **structural 0, quality PASS.** Idempotent re-decision produced an identical provenance
digest; `canTransition('approved_create', …)` is false for every target.

**The gate also caught a bad decision.** An earlier pass created *"Arc Welding (Vernacular)"*
while `skill_arc_welding` already existed, and was refused as **`MISSED_REUSE_CATALOGUE` — "two
rows for one concept split it permanently"**. Both outcomes are recorded, because a gate that
only ever passes has not been tested.

Two further findings from that run: `pending → approved_create` is not a legal single hop (the
service must two-step through `needs_review` in one transaction), and `SKILL_ORPHAN` fires on
`reuses_existing` records too — fixed by supplying the reused skill's **real existing** edges
rather than by touching the gate.

---

## 16. Cost, exactly

**Spent: ₹0.** No provider call has been made by any part of this workstream.

All 9,121 `job_domain_alias` and all 336 `skill_alias` vectors are already present, real,
single-model (`gemini-embedding-001`), L2-normalized (self inner-product 1.0000) and
provenance-stamped. **8,762 of 8,819 distinct phrases are already embedded.**

| item | model | quantity | est. ₹ |
|---|---|---:|---:|
| Embedding gap for a full semantic pass | `gemini-embedding-001` | 57 phrases | **0.034** |
| Extraction — **direct tier only** | `gemini-2.5-flash-lite` | 82 calls | **≈ 0.47** |
| Extraction — direct + ambiguous | `gemini-2.5-flash-lite` | 599 calls | **≈ 3.42** |
| Extraction — all candidates | `gemini-2.5-flash-lite` | 6,673 calls | **38.08** |

Rates from `apps/ai-service/app/ai/model_config.py:180,192`.

**Recommendation: authorize ₹0.47 for the direct tier only.** It is the tier with the real skills
in it, and 82 labels is enough to measure whether extraction is worth ₹38 for the rest.

---

## Source availability — including the empty ones

| source | rows | contribution |
|---|---:|---|
| `job_domain_alias` | 9,121 | the population |
| `job_domain.label_en` (selectable, active) | 3,885 | canonical titles |
| `unresolved_phrase` (open) | 48 | **real worker language**, pseudonymized at rest |
| `chat_messages` (inbound, with text) | 232 | real worker language — mined by `db:mine:aliases`, not yet a discovery source |
| `jobs.description` / `.requirements` | **0 of 19** | **source is empty today** |
| `worker_profiles.skills` | **0 of 22** | **source is empty today** |

The two sources that would carry genuine hiring vocabulary are measurably empty. The pipeline
keeps them wired so they contribute the day the data exists.

---

## What this says about the strategy

1. **`job_domain_alias` is the wrong primary source for skills.** It is an occupation catalogue
   and it measures like one: 1.1% of distinct phrases name an activity. It is excellent evidence
   for *occupation* vocabulary — which is what it was seeded for.
2. **The manageable queue is ~599 decisions across ~491 screens (~13 h)**, not 6,673 across
   3,009 (~167 h). Review `direct` first (~1 h, 74 screens), then `ambiguous`, then *sample* the
   `derived` tail to measure its yield before committing to it.
3. **The 6,074 `derived` candidates are an ontology question, not an engineering one.**
   *"Wood Turner"* → is *wood turning* a canonical skill? That answer decides whether the tail is
   worth ~₹35 and ~150 hours, and it is not an engineering call.
4. **The real skill sources are worker language and job text**, and both are near-empty. The 48
   open unresolved phrases already contain *"vmc opratar"*, *"autocad 2d drafting"*, *"sab
   belding kr leta"* — higher-quality evidence than 9,121 ISCO titles.

---

## What changed and why (vs. the first version of this report)

| figure | first run | this run | cause |
|---|---:|---:|---|
| `ambiguous` phrases | 615 | 552 | Devanagari heads + activity nominalizers |
| `direct` candidates | 57 | 82 | same |
| `ACTIVITY_PHRASE` | 71 | 96 | same |
| `PROSE_FRAGMENT` | 195 | 196 | Devanagari exempted from a unicase-blind rule |
| suggested `map` | 1 | 1 | (already fixed before the first report) |
| review screens | — | 3,009 | grouping added |

---

*Measured 2026-08-26 against `SUPABASE (remote)` as `postgres` (bypass_rls=true), read-only.
Artifacts: `report.json`, `candidates.jsonl`, `review-queue.jsonl`, `review-groups.jsonl`,
`phrases.jsonl` under the run directory. Reproducible from the input fingerprint above.*

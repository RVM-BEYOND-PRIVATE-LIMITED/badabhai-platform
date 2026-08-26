# Skill Discovery Coverage Report — DRY RUN, 2026-08-26

> **Production mutation: NONE. AI spend: ₹0.** No provider was contacted; no row was written.
> Reproduce with `pnpm --filter @badabhai/db db:discover:skills --label full-population`.

| | |
|---|---|
| run id | `sdr_20260826-113020Z_full-population` |
| input fingerprint | `ab8719a26438f13332c2d885444f714b` |
| head-lexicon fingerprint | `880c44221613f1bd081b464746e58a6d` (1,063 heads) |
| target | `SUPABASE (remote)`, role `postgres`, `bypass_rls = true` |
| population predicate | `job_domain_alias` + `job_domain.label_en` of domains `WHERE selectable AND status='active'`; `unresolved_phrase WHERE status='open'` |
| corpus at measurement | 9,121 domain aliases · 4,071 domains · 165 skills (52 active) · 336 skill aliases · 236 taxonomy edges |

---

## The headline answer

**Out of the job-domain alias population, how many represent occupations only, how many carry
evidence of actual skills, how many map to existing skills, how many produce candidate
aliases, how many are genuinely missing skills, and how many need human review?**

Over **8,818 distinct normalized phrases** (from 13,053 source rows):

| disposition | phrases | share | what it means |
|---|---:|---:|---|
| `occupation_only` | **887** | 10.1% | a job title with no modifier naming work. *"Magician"*, *"Operator"*. Yields nothing. |
| `rejected_non_skill` | **251** | 2.8% | scrape prose, residual-bucket markers, contact details, over-length residue. |
| `covered_by_existing_skill` | **26** | 0.3% | already a surface form of a shipped skill. The taxonomy answers it. |
| `alias_opportunity` | **1** | 0.0% | strong equivalence to a shipped skill, different wording. |
| `new_skill_candidate` | **7,038** | 79.8% | skill-shaped or occupation-with-a-modifier, unmatched. |
| `ambiguous` | **615** | 7.0% | no occupation head, no activity marker. A reviewer's call. |

**But `new_skill_candidate` is not 7,038 missing skills, and reading it that way is the
mistake this whole pipeline exists to prevent.** Once clustered and tiered:

| review tier | candidates | what it is |
|---|---:|---|
| **`direct`** | **57** | the phrase names an activity, or matches a shipped skill strongly. *"ac fitting"*, *"bijli welding"*, *"bearing maintenance"*. **This is where the real skills are.** |
| **`derived`** | **6,048** | an occupation title with a modifier. *"Dyer, Leather"* → leather dyeing *might* be a skill. Whether it should be one is an ontology decision, not a token rule. |
| **`ambiguous`** | **580** | shape gives no honest signal. |
| total | **6,685** | |

### What that means in one sentence

`job_domain_alias` is a catalogue of **occupation titles**, not a skill corpus. Only **71 of
8,818 distinct phrases (0.8%)** name an activity directly. Everything else is either a job
title, or a job title from which a skill *could* be derived — and deriving 6,048 of them is
precisely the "do not create 4,000+ canonical skills" outcome you ruled out.

---

## 1–16: the requested figures

| # | figure | measured |
|---|---|---:|
| 1 | Total job-domain aliases | **9,121** (+3,885 domain labels, +47 unresolved phrases = 13,053 source rows) |
| 2 | Unique normalized aliases | **8,818** |
| 3 | Candidate count | **6,685** |
| 4 | Cluster count | **6,700** formed (15 below the attestation floor) |
| 5 | Candidates matching existing canonical skills | **27** (26 covered + 1 alias opportunity) |
| 6 | Candidates requiring new canonical skills | **6,104** suggested `create` — *of which only 57 are `direct` tier* |
| 7 | High-confidence candidates | **0** |
| 8 | Medium-confidence candidates | **1** |
| 9 | Low-confidence candidates | **6,684** |
| 10 | Likely duplicates | **954** phrases absorbed by clustering; **200** near-duplicate pairs escalated, not merged |
| 11 | Likely non-skills | **1,138** (887 occupation-only + 251 rejected) |
| 12 | Distribution by family | see below |
| 13 | Estimated human review workload | **167 h** for all 6,685 · **~16 h** for the 637 `direct`+`ambiguous` |
| 14 | Top 100 for review | `review-queue.jsonl` in the run directory |
| 15 | Ambiguous/unsafe semantic matches | see §"Unsafe matches" |
| 16 | AI/embedding cost | **₹0 spent.** Embeddings: **8,762 of 8,818 phrases already have real vectors** — only 56 missing, est. **₹0.03**. Extraction: est. **₹38.15** for all 6,685, or **~₹3.60** for the 637-candidate tier |

### 12. Distribution by ISCO major family

| family | candidates |
|---|---:|
| Plant and Machine Operators, and Assemblers | 1,733 |
| Craft and Related Trades Workers | 1,230 |
| Technicians and Associate Professionals | 868 |
| Professionals | 828 |
| Managers | 591 |
| Service and Sales Workers | 550 |
| Clerical Support Workers | 373 |
| Elementary Occupations | 251 |
| Skilled Agricultural, Forestry and Fishery Workers | 180 |
| Armed Forces Occupations | 81 |

The two families BadaBhai actually serves — Plant/Machine Operators and Craft/Related Trades —
are **2,963 candidates (44%)**. The remaining 56% are managers, professionals, clerks and
armed forces: real occupations, and not this platform's hiring surface.

### Classifier rules that fired

| rule | phrases |
|---|---:|
| `HEAD_PLUS_EVIDENCE` | 6,979 |
| `HEAD_ONLY_NO_MODIFIER` | 896 |
| `NO_HEAD_NO_ACTIVITY` | 620 |
| `PROSE_FRAGMENT` | 195 |
| `ACTIVITY_HEADED` | 71 |
| `TOO_LONG` | 41 |
| `FORBIDDEN_CHARS` | 13 |
| `ALL_TOKENS_GENERIC` | 3 |

### Attestation breadth — the queue-cutting lever

| distinct domains a cluster appears in | clusters |
|---|---:|
| 1 | 6,251 |
| 2 | 406 |
| 3 | 24 |
| 4 | 3 |
| 5 | 1 |
| 0 (no domain scope) | 15 |

At `--attestation-floor 2` the queue is **434 candidates**, and the report states that 6,266
were excluded. Nothing is trimmed silently.

---

## 15. Unsafe semantic matches — the Phase-4 evidence

Three defects were found and fixed **during this run**, each producing exactly the class of
false match the brief warned about. All three are now regression-tested.

**(a) Specialization read as identity.** The inherited evidence layer graded `strict_token_subset`
as *strong*, which is right between two curated skill labels and wrong between an occupation
title and a skill label:

```
"customs inspector"  ->  quality inspector   subset {inspector} ⊂ {customs, inspector}   STRONG
"bicycle mechanic"   ->  fitter                                                          STRONG
"battery servicing"  ->  plumber                                                          STRONG
```

Same shape as the already-recorded `ducting_installation → plumber` and
`split_unit_installation → fitter`. **Fixed**: subset and overlap are `weak` in this module;
`validateCandidate` refuses any `map`/`merge` suggestion without a strong match
(`WEAK_MATCH_DROVE_ACTION`). Result: suggested `map` fell from 120 to **1**.

**(b) Transitive collapse.** Union-find over a subset relation made it transitive when the
relation is not: `"wood"` ↔ `"wood metal"` ↔ `"metal"` ↔ … One cluster held **8,478 source
rows, 5,706 distinct phrases and 2,814 of the 3,885 domains**. **Fixed**: only identity
relations merge (`MERGE_RELATIONS`); specializations are escalated to the reviewer.

**(c) Consonant-skeleton over-folding.** `skeletonKey` drops interior vowels, so `pile`/`pool`/`ply`
→ `pl`. One cluster contained *"pile-driver operator"*, *"swimming pool cleaner"* and
*"ply bander"*; another held *"battery assembler"* beside *"butter maker"*. **Fixed**: the L1
skeleton is a candidate generator, not a merge decision — its own docblock says so — and it no
longer merges.

**Still escalated, never merged** (a sample of the 200):

```
"engin mechanical" ~ "aeronautical engin mechanical"   [strict_token_subset]
"engin mechanical" ~ "engin marine mechanical"         [strict_token_subset]
"manag manufacturing" ~ "labour manufacturing"         [strict_token_subset]
```

These are genuinely undecidable from shape — is marine mechanical engineering the same
competency as mechanical engineering? — and they reach a human as a question.

Two further defects were found and fixed in the same session: English function words leaking
into evidence tokens (top signatures were `and`, `other`, `and other related`), and `isProse`
discarding lowercase **vernacular** aliases — `"riksha"`, `"plumbing"`, `"bijli welding"` — as
scrape residue. That second one was silently deleting the exact worker language this platform
is built for.

---

## 16. Cost, in detail

**Embeddings — the finding that makes this cheap.** All 9,121 `job_domain_alias` and all 336
`skill_alias` vectors are already present, real, single-model (`gemini-embedding-001`),
L2-normalized (self inner-product 1.0000), and provenance-stamped. **8,762 of 8,818 distinct
phrases are already embedded.** A semantic pass over the whole population needs **56 new
embeddings ≈ ₹0.03**, one provider request.

**Extraction** (canonical label + description per candidate, `gemini-2.5-flash-lite` at
₹0.008/₹0.033 per 1k in/out — `model_config.py:180`):

| scope | calls | est. tokens (in/out) | est. ₹ |
|---|---:|---:|---:|
| all candidates | 6,685 | 2.29M / 602k | **38.15** |
| `direct` + `ambiguous` only | 637 | ~218k / 57k | **~3.60** |
| `direct` only | 57 | ~20k / 5k | **~0.33** |

**Nothing has been spent. No call has been made.**

---

## Source availability — measured, including the empty ones

| source | rows available | contribution |
|---|---:|---|
| `job_domain_alias` | 9,121 | the population |
| `job_domain.label_en` (selectable, active) | 3,885 | canonical titles |
| `unresolved_phrase` (open) | 47 | **real worker language**, pseudonymized at rest |
| `chat_messages` (inbound, with text) | 232 | real worker language — *wired but not yet read; needs the pseudonymizer* |
| `jobs.description` / `.requirements` | **0 of 19** | **source is empty today** |
| `worker_profiles.skills` | **0 of 22** | **source is empty today** |

Stated rather than omitted: the two employer/worker-derived sources that would carry genuine
hiring vocabulary are measurably empty. The pipeline keeps them wired so they contribute the
day the data exists.

---

## What this says about the strategy

1. **`job_domain_alias` is the wrong primary source for skills.** It is an occupation
   catalogue and it measures like one: 0.8% of distinct phrases name an activity. It is
   excellent evidence for *occupation* vocabulary — which is what it was seeded for, and where
   it already works.
2. **The manageable queue is ~637 decisions (~16 h), not 6,685 (~167 h).** The `direct` and
   `ambiguous` tiers are where a reviewer's hour pays. Recommendation: review those first,
   then *sample* the `derived` tail to measure its yield before committing to it.
3. **The 6,048 `derived` candidates are an ontology question, not an engineering one.**
   "Wood Turner" → is *wood turning* a canonical skill? That answer decides whether this tail
   is worth ₹35 of extraction and 150 hours of review, and it is not mine to give.
4. **The real skill sources are worker language and job text**, and both are near-empty. The
   47 open unresolved phrases already contain *"vmc opratar"*, *"autocad 2d drafting"*,
   *"sab belding kr leta"* — higher-quality evidence than 9,121 ISCO titles.

---

*Measured 2026-08-26 against `SUPABASE (remote)` as `postgres` (bypass_rls=true), read-only.
Artifacts: `report.json`, `candidates.jsonl`, `review-queue.jsonl`, `phrases.jsonl` under the
run directory. Reproducible from the input fingerprint above.*

# D-6 — vernacular coverage: what exists, what is measured, and what to build

**2026-08-21 · main `6c50bbb3` · repository analysis only · production mutation NONE · AI spend ₹0**

Evidence: [`d6-vernacular-coverage.json`](./d6-vernacular-coverage.json) ·
reproduce with `pnpm db:audit:vernacular --json=<out>` (no database, no credentials, no spend).

Every claim is tagged:
**[CODE]** traced in the implementation · **[DATA]** measured from committed data ·
**[DESIGN]** stated intent · **[REC]** recommendation, deciding nothing ·
**[NOT MEASURED]** no evidence either way.

---

## CORRECTION — 2026-08-21, same day

**The first version of this document said Hinglish was "NOT MEASURED — 0 cases". That was
wrong.** It was true of `retrieval-v3.jsonl` and false of the platform, and I had not looked
beyond the one fixture before saying so.

There is a **second, older evaluation instrument** — the wedge eval
(`apps/ai-service/tests/wedge_eval/scores_2026_07_14.json`, `gemini-embedding-001`, real
vectors, 33 cases) — that measures romanized Hindi directly. Its evidence **strengthens** §0's
conclusion in one place and **overturns** it in another, and §2A now carries both.

~~There is also an owner-ratified remediation from 2026-07-16 that **was never shipped**.~~

**Second correction, 2026-08-24: that was wrong too.** The 22 ratified aliases were shipped on
2026-07-16 — the ratification date — and all 22 are embedded in production. §2B carries the
measurement and an account of how I got it wrong. What is genuinely outstanding is the
**re-sweep**, which has never run, so the 0.350 recall on record is still the pre-alias number.

---

## 0. The finding that reframes the task

The task was framed as *"make retrieval robust to how Indian workers actually speak"*, with an
implicit worry that Hindi phrasing is what pushes scores under the 0.75 floor. **[DATA]** That
is not what the recorded run says:

| register / category | n | mean | median | < floor | correct |
|---|---:|---:|---:|---:|---:|
| `english_latin` / `exact_alias` | 24 | **1.0000** | 1.0000 | 0 | 24/24 |
| `devanagari` / `devanagari_alias` | 15 | **1.0000** | 1.0000 | 0 | 15/15 |
| `english_latin` / `paraphrase_latin` | 66 | **0.7465** | 0.7544 | 32 | 61/66 |
| `devanagari` / `devanagari_paraphrase` | 24 | **0.7520** | 0.7521 | 12 | 22/24 |
| `english_latin` / `cross_domain_isolation` | 8 | 0.5766 | 0.5660 | 8 | 0/8 ✔ |
| `devanagari` / `cross_domain_isolation` | 2 | 0.5614 | 0.5614 | 2 | 0/2 ✔ |

Read the two paraphrase rows against each other. **Hindi paraphrase scores *marginally higher*
than English paraphrase** (0.7520 vs 0.7465) and clears the floor at almost the same rate
(50.0% vs 48.5% below). Exact aliases score a perfect 1.000 in **both** scripts.

> **Floor pressure is a property of PARAPHRASE, not of language.** The discriminator is lexical
> distance from a stored alias, and script is not correlated with it.

Two consequences, and they point in opposite directions from the original framing:

1. **[REC]** Vernacular work should not be justified as "fixing the floor", and this document
   provides no argument for moving 0.75. If anything it removes one: the language hypothesis
   for below-floor scores is now measured and rejected.
2. **[REC]** The lever that *does* move paraphrase scores is reducing lexical distance —
   i.e. **the alias corpus** (Layer B), not the model and not the threshold.

The `cross_domain_isolation` rows are the floor earning its keep: negatives sit at ~0.57, well
clear of 0.75, in both scripts. Precision is not the thing under strain.

---

## 1. The pipeline, traced

**[CODE]** There are two retrieval paths and they are **not** built the same way. That
asymmetry is the central architectural finding.

### Occupation resolution — three tiers, vernacular-aware

```
worker phrase
  → normalizeOccupationText()      NFKC, lowercase, punctuation, PARTICLE STRIPPING
  → L0  exact  job_domain_alias.text_norm
  → L2  fuzzy  pg_trgm word_similarity over text_norm
  → L3  ANN    HNSW cosine over job_domain_alias.embedding  WHERE is_searchable
  → resolved job_domain_id
```

**[CODE]** `normalizeOccupationText` is called by both the seeder and the query path — the
symmetry is the stated safety property, since two normalizers that drift silently reduce L0 to
zero hits.

### Skill canonicalization — one tier, no normalization

```
worker phrase
  → pseudonymize (SG-2, fail-closed)
  → embed_text(phrase)             RAW TEXT. No normalization. No particle stripping.
  → ANN cosine over skill_alias.embedding, domain-scoped
  → floor gate 0.75  → assign skill_id | UNRESOLVED (+ unresolved_phrase)
```

**[CODE]** `skill_alias.text_norm` exists and is populated, and **no query reads it** — there
is no L0 or L2 tier on the skill side. Verified by searching the skills repository: the only
statements are the two vector searches.

**[CODE]** `canonicalize.py` calls `embed_text(phrase, settings)` on the phrase as received.
`normalizeOccupationText` is never applied on this path.

### So where does each vernacular mechanism live?

| mechanism | occupation path | skill path |
|---|---|---|
| NFKC / case / punctuation | **[CODE]** yes, in the normalizer | no — raw text to the embedder |
| Hinglish particle stripping (38 tokens) | **[CODE]** yes, load-bearing for L0/L2 | **no** |
| Devanagari aliases | **[CODE]** yes, stored as separate rows | **[DATA]** yes — 396 `hi` aliases |
| transliteration | **[DESIGN]** explicitly none — *"Devanagari is NEVER transliterated; both scripts are separate alias rows"* | none |
| exact-match tier | **[CODE]** L0 on `text_norm` | **none** |
| fuzzy tier | **[CODE]** L2 trigram | **none** |
| embedding | `gemini-embedding-001` @ 768 | same |
| threshold | family-binding / disambiguation logic | **0.75 floor** |

**The single most consequential line in this table:** the particle vocabulary — 38 tokens, 10
suffixes, 13 phrases, covering both `ka kaam karta hun` and `का काम` — is the platform's one
purpose-built Hinglish mechanism, and **it does not run on the skill path at all.**

---

## 2. What is measured versus what is assumed

**[DATA]** The committed fixture holds 168 cases in exactly two registers:

| register | cases |
|---|---:|
| `english_latin` | 127 |
| `devanagari` | 41 |
| **`hinglish_latin`** | **0** |

**[DATA]** Zero of the 127 Latin-script queries contain **any** of the 24 Latin-script
particles. `paraphrase_latin` is a misleading category name: all 66 cases are fluent English
prose ("driving the forklift in the warehouse"), not romanized Hindi.

> **The retrieval fixture that governs promotion has no romanized-Hindi coverage at all.**
> Romanized Hindi *is* measured — by the separate wedge eval (§2A) — so the accurate statement
> is that the two instruments disagree about what matters, and the one wired to the gates is
> the one that is blind to it. The particle mechanism is also not wired into the skill path.

**[DATA]** `lang` takes only `en` and `hi`, though `LANGUAGE_CODES` admits twelve
(`en hi bn te ta mr gu kn ml pa or as`). The committed alias corpus is 392 `en` / 396 `hi` and
contains no other language.

### The gap taxonomy, with honest status

| category | example | status |
|---|---|---|
| Hindi / Devanagari | `वेल्डिंग करना` | **MEASURED** — alias R@1 1.000; paraphrase R@1 0.917 |
| English paraphrase | `checking the weld looks clean` | **MEASURED** — R@1 0.955 |
| Hinglish / romanized | `motor repair karta hoon` | **MEASURED — in the wedge eval, not this fixture.** See §2A |
| Latin transliteration | `bijli ki wiring` | **MEASURED** for 5 single-word trade terms (§2A); absent from `retrieval-v3` |
| Code-switching | `panel ka wiring aur breaker testing` | **NOT MEASURED** — 0 cases in either instrument |
| Spelling variation | `weldar`, `vaildar` | **NOT MEASURED** — 0 cases in either instrument |
| Colloquial activity | `motor khol ke seal badalta hoon` | **PARTIAL** — the Devanagari paraphrases are activity descriptions; the romanized form is absent |
| Regional languages | Marathi, Tamil, Bengali… | **NOT MEASURED** — no corpus, no fixture, no aliases. **An evidence gap, not an established requirement.** |

**[REC]** Regional-language support must not be assumed into the roadmap. There is no demand
evidence in this repository. Treat it as a question for the product owner, not a backlog item.

---

## 2A. The wedge eval — Hinglish measured, and the floor argument settled

**[DATA]** `apps/ai-service/tests/wedge_eval/scores_2026_07_14.json` — 33 cases,
`gemini-embedding-001`, real vectors, anchored on `cnc-machining`.

| tier | n | score range | what it shows |
|---|---:|---|---|
| `exact` | 12 | 0.859 – 1.000 | alias hits are perfect, as in `retrieval-v3` |
| `paraphrase` (romanized Hindi) | 8 | **0.666 – 0.902** | 5/8 correct at rank 1 |
| `vernacular` (single Hindi trade word) | 5 | **0.528 – 0.603** | **4/5 CORRECT — and all 5 below the floor** |
| `negative` | 6 | **0.518 – 0.572** | correctly unmatched |
| `cross_domain` | 2 | 0.577 – 0.598 | correctly unmatched |

Two findings, and the second is the important one.

**First — Hinglish paraphrase corroborates §0.** `lathe machine chalana` 0.8235,
`surface grinding ka kaam` 0.9020, `micrometer se measurement` 0.8217, `job set karna` 0.7815,
`thread katna` 0.7219, `welding karna` 0.7212, `g code likhna` 0.7220, `program banana` 0.6664.
That distribution sits right alongside English paraphrase (mean 0.7465). **Romanized Hindi
paraphrase is not measurably harder than English paraphrase.** §0 stands.

**Second — single-word vernacular is a genuinely different population, and it settles the
floor question in the opposite direction from the one people expect:**

```
correct vernacular   chhilai 0.5284   ghisai 0.5352   kharad 0.5750   chudi katna 0.5863   kharad ka kaam 0.6034
negatives            security guard ki naukri 0.5183   astrophysics lecturer 0.5290   english bolna 0.5298
                     biryani banana 0.5427   driving licence hai 0.5402   computer typing 0.5722
```

**These two sets interleave.** `chhilai` is the CORRECT answer at 0.5284 and scores *below*
`biryani banana` at 0.5427. There is no threshold anywhere that admits the true vernacular
matches and rejects the nonsense ones.

> **[DATA] Lowering the floor cannot fix vernacular coverage. It is not a tuning problem —
> the correct and incorrect answers are not separable by score at all in this register.**

This is a stronger statement than §0 made, and it points at the same remedy from a different
direction: the only thing that moves `chhilai` from 0.53 to a trustworthy match is **having the
word in the corpus**, which makes it an exact hit at ≈1.0. Not a threshold, not a model.

**[REC]** This evidence belongs in the 0.75 floor owner decision as an argument *against*
lowering it. It is not permission to change anything.

---

## 2B. ~~Twenty-two ratified vernacular aliases were never shipped~~ — WRONG, corrected 2026-08-24

> ### This section was wrong. The aliases shipped on the ratification date.
>
> **MEASURED 2026-08-24, read-only:** all 22 are in production `skill_alias`, all 22 carry a
> `gemini-embedding-001` vector, all 16 target skills are `active`, and every row has a
> `domain_id` so the legacy retrieval path can reach them. 21 were created **2026-07-16** — the
> day they were ratified; `drawing padhna` on 2026-08-20 (the Q-B remap).
>
> **How I got it wrong.** Three compounding mistakes, none of them a typo:
>
> 1. I checked `SKILL_CORPUS`'s literal alias arrays and `data/taxonomy/skills.jsonl`, found the
>    phrases in neither, and called them undelivered. **Neither file is where a delivered alias
>    lives** — `skill_alias` is, and I never queried it.
> 2. I grepped for the identifier `WEDGE_ALIASES` to find a consumer. `seed-skills.ts` consumes
>    the accessor `ratifiedWedgeAliases()`, so the grep missed a wire that was **fully
>    connected** — the planner even takes the wedge as a dedicated parameter.
> 3. `skill-vernacular-ratification-packet.md` said seed/embed were "PENDING the SR-1 staging
>    env". That line was five weeks stale and corroborated the wrong answer.
>
> **What IS still owed:** step 5, the re-sweep. The only wedge scores on disk are
> `scores_2026_07_14.json`, which predates the ratification — so **the 0.350 recall quoted below
> is the pre-alias number and is not the shipped state.** Measuring the shipped state needs a
> paid run and is not authorized here.
>
> The rest of this section's evidence — the 0.528–0.603 scores, the interleaving with negatives,
> the floor conclusion — was measured on 2026-07-14 and is unaffected. Only the delivery claim
> was wrong.

### The original text, kept for the record

> **SUPERSEDED — DO NOT QUOTE ANY SENTENCE BELOW.** Every delivery claim in it is false.
> Specifically: "no seeder consumes `WEDGE_ALIASES`" (the seeder consumes the accessor
> `ratifiedWedgeAliases()`, and `planSeedSkills` takes the wedge as a parameter); "blocked for
> five weeks" (seed and embed ran on the ratification date); "converts a ~0.55 UNRESOLVED into
> a ≈1.0 exact hit" (the ~0.55 is measured 2026-07-14, the ≈1.0 is an unverified prediction and
> the wedge eval's own exact tier spans 0.859–1.000); "all 22 target skills" (22 aliases, **16**
> distinct target skills); "would improve retrieval for skills that actually reach matching"
> (only **6 of the 16** carry a non-empty bridge mapping — 8 of the 22 aliases).
>
> And the outcome it promised did not occur: see `d60-anchor-path-retrieval.json` — **8 of 22
> reachable on the scope production queries, and two produce a false assignment above the
> floor.**

**[DATA]** `docs/registers/skill-vernacular-ratification-packet.md`: **22 vernacular aliases
RATIFIED by the RVM domain owner on 2026-07-16**, none struck, with two explicit rulings
(Q-A `chhilai` → `skill_deburring`, Q-B `drawing padhna` → `skill_drawing_reading`).

**[DATA]** They live in `packages/taxonomy/src/wedge-aliases.ts` as `WEDGE_ALIASES`, all
carrying `ratified: true`. And:

- **none of the 22 appears in `packages/db/data/taxonomy/skills.jsonl`** (197 committed aliases,
  zero matches for `kharad`, `chhilai`, `ghisai`, `chudi katna`, `chhed karna`,
  `finishing ka kaam`, `job setting`);
- **no seeder consumes `WEDGE_ALIASES`.** The only non-test reference in the repository is the
  generated `dist/wedge-aliases.d.ts`.

The packet itself flags the dependency — *"Seed / embed / re-sweep remain PENDING the SR-1
staging env"* — so this is a known blocked step, not a forgotten one. But it has been blocked
for **five weeks**, and the measurement says each of those aliases converts a ~0.55
UNRESOLVED into a ≈1.0 exact hit.

> ~~**The highest-value vernacular work in this repository is already designed, already
> measured, and already ratified by the owner. It is unshipped.**~~
>
> **FALSE — see the correction at the head of this section. It was shipped on 2026-07-16.**

**[DATA]** All 22 target skills are in `SKILL_CORPUS` (0 dangling) and **0 of the 22 appear as
`SKILL_CORPUS` aliases**. That corpus is exactly the set `ATTRIBUTE_TO_MATCH_SKILLS` covers, so
these aliases would improve retrieval for skills that **actually reach matching** — unlike the
96 promotable growth skills, which reach nothing (Q1, TASK 9B).

They target `SKILL_CORPUS`, **not** the D2 growth corpus in `data/taxonomy/skills.jsonl`. The
two are disjoint id spaces, and an earlier draft of the delivery tripwire checked the wrong one
and reported 15 skills as "dangling" that were nothing of the kind.

**[REC]** This reorders the roadmap: the first vernacular improvement is not authoring new
material, it is delivering material a human already approved. It is also the *cheapest* — the
decision cost is spent, and only seeding + embedding remains. It is **not** actioned here: it
requires a corpus write and a paid embed run, both owner-gated.

---

## 3. Where vernacular support should live

Assessed per layer, against the measurement above.

### Layer A — input normalization · **[REC] highest value, lowest risk**

The asymmetry is not defensible on its face: the skill path embeds raw text while the
occupation path normalizes. **[REC]** Applying `normalizeOccupationText` to the skill query
before embedding would make "welding ka kaam karta hun" and "welding" converge, at zero
recurring cost and no vocabulary change.

**[REC]** But it must be measured before it is shipped, and it cannot be done unilaterally:
the stored `skill_alias` embeddings were computed from **raw** alias text. Normalizing only the
query introduces an asymmetry of a different kind. Either both sides normalize (which means
re-embedding the alias corpus — a paid run) or neither does. **This is the central design
question D6-2 must answer with evidence.**

### Layer B — alias corpus · **[REC] the lever the data actually supports**

Paraphrase scores hover at the floor because the phrase is lexically distant from every stored
alias. Adding *validated worker-language aliases* to existing skills shortens that distance
directly. **[REC]** This is preferred over every other option: it is data, not code; it is
reversible; it does not touch matching; and it needs no threshold change.

### Layer C — embeddings · **[DATA] already adequate, and proven so**

`gemini-embedding-001` bridges Devanagari → canonical English at **R@1 0.917 / R@3 1.000**
with no transliteration layer. **[REC]** Do not change the model. The cross-script bridge is
not the weak link, and this is measured, not assumed.

### Layer D — reranking / disambiguation · **[REC] later, and narrow**

**[DATA]** R@3 is **1.000 in every category.** The correct answer is essentially always in the
top three; only the ordering is wrong. That is precisely the shape reranking fixes — and
equally, the shape that means the retrieval layer is not broken. **[REC]** Defer until Layers
A and B are measured; revisit only for the residual sibling ambiguity (TP-27, TP-08, TP-01,
TP-15), which is genuine conceptual overlap, not a language problem.

### Layer E — structured extraction · **[REC] already the architecture; do not extend it**

Extraction already produces attribute skills, and canonicalization runs on those. Pushing more
language understanding into the LLM adds per-turn cost and nondeterminism to a path whose
deterministic half is working. **[REC]** No change.

### Layer F — threshold · **out of scope, and unsupported by this evidence**

See §0.

---

## 4. Transliteration strategy

| option | accuracy | latency | cost | determinism | verdict |
|---|---|---|---|---|---|
| **A** normalize before embedding | unknown — needs D6-2 | none | none recurring | full | **[REC] evaluate first.** Cheapest, but see the re-embedding asymmetry in §3 Layer A |
| **B** rely on multilingual embeddings | **[DATA]** 0.917 R@1 Devanagari | none | none | full | **[REC] already the status quo, and it works** |
| **C** dual representation | likely best recall | +1 lookup | 2× alias embeddings | full | **[REC] defer** — doubles corpus cost for an unquantified gain |
| **D** LLM extraction first | high | +1 model call/turn | per turn, forever | **none** | **[REC] reject** for canonicalization. Nondeterminism where a deterministic answer exists violates the "AI never owns business decisions" boundary |

**[REC]** No transliteration library. The design already states Devanagari is never
transliterated, and B measured well. The open question is A, and it is an experiment, not a
decision.

---

## 5. Evaluation design — the D6-1 fixture

**[CODE]** The instrument needs no change: `taxonomy-retrieval-eval.ts` already segments
`by_category` and reports R@1/R@3/R@5/MRR, and the floor sweep already emits `per_case` scores.
**Adding categories to the fixture is sufficient to measure them.**

**[REC]** Structure per canonical skill — but only for categories that are meaningful, and
built by a human who speaks the register:

| category | why it earns a slot |
|---|---|
| `hinglish_paraphrase` | the measured hole, and the register the particle corpus targets |
| `hinglish_transliteration` | tests Layer A directly; distinct from paraphrase |
| `code_switched` | Hindi frame with English technical nouns — the realistic worker utterance |
| `spelling_variation` | tests L2/ANN robustness; cheap to author |

**[REC]** Sizing: **3–5 cases per category per domain**, not per skill. Per-skill generation
would produce hundreds of cases whose marginal information is near zero, and each one costs a
paid embedding at evaluation time.

**[REC] Authoring rules, each derived from something that actually went wrong:**

1. **Sibling lexical hygiene is mandatory** — see §6. Non-negotiable.
2. **No alias echoes.** A query that *is* the skill's alias asks the index whether a string
   matches itself. `countsAsEvalCoverage` already refuses these.
3. **Human-authored, `review_status: reviewed`.** Machine-generated paraphrase is how TP-36
   and TP-19 happened.
4. **Label genuine ambiguity as ambiguity.** Where two sibling skills honestly both fit, record
   it with `acceptable_skill_ids` rather than forcing a single answer. The four existing
   ambiguity cases are evidence and must not be rewritten.

---

## 6. The rule that must outlive this document

TP-36 ended "before shearing" while `skill_shearing_machine_operation` was a sibling in the
same domain; TP-19 said "on the mig machine" against a sibling `skill_mig_welding`. Both
retrieved the sibling — at 0.7216 and 0.6923 — and both were **author errors, not retrieval
errors**. A phrase naming a sibling's identity cannot measure anything, because no correct
answer exists for retrieval to find.

> **[DESIGN] Vernacular paraphrase quality requires sibling lexical-hygiene validation, not
> merely translation quality.**

A translation can be perfectly faithful and still be an unmeasurable test case. This is *more*
dangerous in vernacular authoring, not less: an author working across scripts is concentrating
on meaning, and a sibling's English brand name ("MIG", "CNC") survives into Hindi text
untranslated and unnoticed.

**Encoded, not just written down.** `siblingLexicalLeaks` is now a reusable function rather
than logic inline in one test, and it is asserted **across all 168 cases** rather than the 41
trainer cases the original check covered. **[DATA]** The whole fixture passes today — so the
narrower scope was leaving the inherited v2 cases unguarded for no benefit. Any future fixture
inherits the guarantee by calling one function.

---

## 7. Roadmap

| phase | work | needs spend? | gate |
|---|---|---|---|
| ~~**D6-0**~~ | ~~Ship the 22 already-ratified wedge aliases~~ — **ALREADY DONE 2026-07-16** (§2B). What remains is the **re-sweep** that measures the effect. | paid embed (~INR 0.003) | owner |
| **D6-1** | Author the vernacular fixture (4 categories, human-written, hygiene-checked). Extend `Register` coverage assertions. | **₹0** | none — repository work |
| **D6-2** | Run the existing instrument over it. Also run the Layer-A experiment: normalized query vs raw, same corpus. | **paid embeddings — STOP and request approval first** | owner |
| **D6-3** | If D6-2 shows lexical distance is the cause, add validated worker-language aliases to existing skills. Corpus edit + embed run. | paid embed | owner |
| **D6-4** | Retrieval changes (L0/L2 tier on the skill path) — **only** if D6-2 shows a retrieval limitation | — | owner |
| **D6-5** | Reranking — only for residual sibling ambiguity after D6-3 | — | owner |
| **D6-6** | Production decision | — | owner |

**[REC]** D6-1 is the only phase that should start without a further decision. **The shipping
half of D6-0 is already done**; what is left of it — and D6-2 — require paid runs and must not
be self-authorized. The re-sweep is the one to authorize first: it is the only outstanding item
with a defined before (0.350, 2026-07-14) and an unmeasured after.

---

## 8. Vocabulary pollution — the line that must hold

**[DESIGN]** The distinction is load-bearing and D-6 must not blur it:

```
occupation  ≠  skill  ≠  alias  ≠  vernacular expression
```

**[REC]** A vernacular expression is an **alias of an existing skill**, not a new skill. "motor
khol ke seal badalta hoon" is `skill_pump_and_valve_repair` in a worker's words — minting a
skill for it would fragment the vocabulary, split the embedding mass of one concept across two
ids, and make matching worse while looking like coverage growth.

**Explicitly rejected: "add every Hindi/Hinglish phrase as a new skill."**

**[REC]** A genuinely missing *concept* is a different finding and arrives through the existing
growth loop (`unresolved_phrase` → review → batch), which already has gates. Vernacular work
must not become a side door into the skill corpus that bypasses them.

---

## 9. Cost

**AI spend for D-6: ₹0.** Repository analysis and design need no model calls; the audit reads
committed files only.

**[REC]** D6-2 needs paid embeddings. The order of magnitude, for scoping only: the v3 run
embedded 164 queries and the recorded metered cost of that experiment is in the sweep record.
A four-category fixture at 3–5 cases per category per domain is the same order. **No spend is
authorized here and none was incurred.**

---

## 10. The ten questions, answered

1. **What support exists?** **[CODE]** Devanagari aliases (396 `hi` rows), a multilingual
   embedding model, and a 38-token Hinglish particle stripper.
2. **Where?** Normalization + L0/L2/L3 on the **occupation** path. On the **skill** path:
   the embedding model alone — raw text, ANN only, no normalization, no exact tier.
3. **Measured vs assumed?** Devanagari **measured** (alias 1.000, paraphrase 0.917). English
   paraphrase **measured** (0.955). Romanized Hindi **measured — but by the wedge eval, not by
   the gate-bearing fixture** (§2A): paraphrase 0.666–0.902, single-word trade terms
   0.528–0.603. Code-switching, spelling variation, regional languages: **NOT MEASURED in
   either instrument.**
4. **What's missing from evaluation?** The categories in §5 — above all `hinglish_latin` in
   `retrieval-v3`, which is the register the particle corpus was purpose-built for and the one
   the promotion gates cannot see. The wedge eval covers it but governs nothing.
5. **Preventing sibling leakage?** §6 — `siblingLexicalLeaks`, now reusable and asserted over
   all 168 cases.
6. **Aliases, embeddings, normalization, or extraction?** **[REC]** Aliases (Layer B) first,
   normalization (Layer A) second and only after the re-embedding asymmetry is resolved by
   measurement. Not the model. Not extraction.
7. **Lowest-risk path?** **The D6-0 re-sweep first** — the 22 aliases are already live (§2B), so
   this measures a change already in production rather than making one.
   Then D6-1 → D6-2 → D6-3. Delivering an approved decision outranks authoring new material.
8. **How to prove improvement without false assignments?** The instrument already reports
   `cross_domain_isolation` and `competitor_outranking` alongside recall. **[REC]** Any
   vernacular change must hold those constant while recall rises — recall alone is not proof.
9. **Does it require changing 0.75?** **[DATA] No — and the wedge eval makes that conclusive,
   not merely unsupported.** Hindi paraphrase clears the floor at the same rate as English; and
   for single-word vernacular the correct answers (0.528–0.603) *interleave* with the negatives
   (0.518–0.572), so **no threshold separates them at all** (§2A). Lowering the floor to admit
   `chhilai` (0.5284) would also admit `biryani banana` (0.5427). The fix is the corpus, not
   the threshold. This is evidence **for** the existing floor, not permission to move it.
10. **Owner decisions required?** See below.

---

## 11. Owner decisions

**Decision 0 — ~~Ship the 22 ratified wedge aliases?~~ Re-sweep to measure the ones already shipped**
*(Corrected 2026-08-24: the shipping question is moot — 21 rows went live on the ratification
date, `drawing padhna` on 2026-08-20. **Every line of the decision body below is void**: the
aliases are in the corpus, the seeder does consume them, no write or embed is pending, and
option (c) "strike the ratification" would now mean deleting live production rows. The live
question is whether to authorize the ~INR 0.003 re-sweep.)*
*Evidence:* ratified by the RVM owner 2026-07-16, none struck; all 22 target live
`SKILL_CORPUS` skills; none is in the corpus; nothing consumes `WEDGE_ALIASES`. Measured
before/after: ~0.55 UNRESOLVED → ≈1.0 exact.
*Options:* (a) authorize the corpus write + embed; (b) keep waiting on SR-1; (c) strike the
ratification.
*Recommendation:* **(a).** It is the highest-value, lowest-uncertainty vernacular work
available, and the expensive part — human judgement — is already spent.
*Risk:* one corpus write and one small embed run. The aliases target `SKILL_CORPUS`, which is
inside the runtime bridge, so the benefit reaches matching.
*If chosen:* five weeks of ratified work lands. *Still blocked:* nothing.
*Not actioned here:* corpus write and paid embed are both owner-gated.

**Decision 1 — Authorize D6-2's paid embedding run?**
*Evidence:* four vernacular categories have zero coverage; the instrument is ready.
*Options:* (a) authorize a scoped run after D6-1; (b) defer; (c) reject.
*Recommendation:* (a), scoped and quoted before execution.
*Risk:* small, bounded, one-off.
*If chosen:* the Hinglish gap becomes measured. *Still blocked:* nothing.

**Decision 2 — Should the skill path normalize before embedding?**
*Evidence:* the occupation path does; the skill path does not; stored embeddings were computed
from raw text.
*Options:* (a) normalize both sides (requires re-embedding the alias corpus); (b) normalize
neither (status quo); (c) query-only (**not recommended** — introduces a new asymmetry).
*Recommendation:* decide **after** D6-2 measures it; do not choose on intuition.
*Risk:* (a) is a paid re-embed of the corpus. *Still blocked:* Layers A and D.

**Decision 3 — Are regional languages in scope at all?**
*Evidence:* `LANGUAGE_CODES` allows twelve; corpus and fixture use two; **no demand evidence
in the repository.**
*Recommendation:* explicitly out of scope until product supplies demand evidence.
*Risk:* scoping in prematurely multiplies corpus and embedding cost by the language count.

---

## 12. Unchanged

```
0.75 floor              OWNER DECISION — untouched, and unsupported by this evidence
NO_REGRESSION           OWNER DECISION — untouched
Q1 bridge coverage      OWNER DECISION — untouched
PROMOTION CANDIDATES    0
```

Nothing in D-6 evaluates, sweeps, promotes, re-baselines, adds a skill, adds an alias, or
changes matching. No production mutation. **AI spend ₹0.**

---

## 13. Carried forward — infrastructure

**The Supabase pooler blocked read-only verification seven times in this session**
(`EMAXCONNSESSION … pool_size: 15`). D-6 needed no database and was unaffected, but the
constraint is now the binding limit on any measurement task. **[REC]** It warrants its own
infrastructure task and owner; it is deliberately **not** addressed here.

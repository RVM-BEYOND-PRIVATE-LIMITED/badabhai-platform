# D-6 — vernacular coverage: what exists, what is measured, and what to build

**2026-08-21 · main `6c50bbb3` · repository analysis only · production mutation NONE · AI spend ₹0**

Evidence: [`d6-vernacular-coverage.json`](./d6-vernacular-coverage.json) ·
reproduce with `pnpm db:audit:vernacular --json=<out>` (no database, no credentials, no spend).

Every claim is tagged:
**[CODE]** traced in the implementation · **[DATA]** measured from committed data ·
**[DESIGN]** stated intent · **[REC]** recommendation, deciding nothing ·
**[NOT MEASURED]** no evidence either way.

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

> **The one vernacular mechanism the codebase invested in has never been evaluated, in either
> path.** It is also not wired into the path where skills are resolved.

**[DATA]** `lang` takes only `en` and `hi`, though `LANGUAGE_CODES` admits twelve
(`en hi bn te ta mr gu kn ml pa or as`). The committed alias corpus is 392 `en` / 396 `hi` and
contains no other language.

### The gap taxonomy, with honest status

| category | example | status |
|---|---|---|
| Hindi / Devanagari | `वेल्डिंग करना` | **MEASURED** — alias R@1 1.000; paraphrase R@1 0.917 |
| English paraphrase | `checking the weld looks clean` | **MEASURED** — R@1 0.955 |
| Hinglish / romanized | `motor repair karta hoon` | **NOT MEASURED** — 0 cases |
| Latin transliteration | `bijli ki wiring` | **NOT MEASURED** — 0 cases |
| Code-switching | `panel ka wiring aur breaker testing` | **NOT MEASURED** — 0 cases |
| Spelling variation | `weldar`, `vaildar` | **NOT MEASURED** — 0 cases |
| Colloquial activity | `motor khol ke seal badalta hoon` | **PARTIAL** — the Devanagari paraphrases are activity descriptions; the romanized form is absent |
| Regional languages | Marathi, Tamil, Bengali… | **NOT MEASURED** — no corpus, no fixture, no aliases. **An evidence gap, not an established requirement.** |

**[REC]** Regional-language support must not be assumed into the roadmap. There is no demand
evidence in this repository. Treat it as a question for the product owner, not a backlog item.

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
| **D6-1** | Author the vernacular fixture (4 categories, human-written, hygiene-checked). Extend `Register` coverage assertions. | **₹0** | none — repository work |
| **D6-2** | Run the existing instrument over it. Also run the Layer-A experiment: normalized query vs raw, same corpus. | **paid embeddings — STOP and request approval first** | owner |
| **D6-3** | If D6-2 shows lexical distance is the cause, add validated worker-language aliases to existing skills. Corpus edit + embed run. | paid embed | owner |
| **D6-4** | Retrieval changes (L0/L2 tier on the skill path) — **only** if D6-2 shows a retrieval limitation | — | owner |
| **D6-5** | Reranking — only for residual sibling ambiguity after D6-3 | — | owner |
| **D6-6** | Production decision | — | owner |

**[REC]** D6-1 is the only phase that should start without a further decision. **D6-2 requires
paid embedding calls and must not be self-authorized.**

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
   paraphrase **measured** (0.955). Hinglish, transliteration, code-switching, spelling
   variation, regional languages: **NOT MEASURED, zero cases.**
4. **What's missing from evaluation?** The four categories in §5 — above all `hinglish_latin`,
   which is the register the particle corpus was purpose-built for.
5. **Preventing sibling leakage?** §6 — `siblingLexicalLeaks`, now reusable and asserted over
   all 168 cases.
6. **Aliases, embeddings, normalization, or extraction?** **[REC]** Aliases (Layer B) first,
   normalization (Layer A) second and only after the re-embedding asymmetry is resolved by
   measurement. Not the model. Not extraction.
7. **Lowest-risk path?** D6-1 → D6-2 → D6-3. Fixture, then measurement, then data.
8. **How to prove improvement without false assignments?** The instrument already reports
   `cross_domain_isolation` and `competitor_outranking` alongside recall. **[REC]** Any
   vernacular change must hold those constant while recall rises — recall alone is not proof.
9. **Does it require changing 0.75?** **[DATA] No — and the evidence argues against the
   premise.** Hindi paraphrase clears the floor at the same rate as English. Floor pressure is
   about paraphrase distance, not language. The floor stays an owner decision on its own terms.
10. **Owner decisions required?** See below.

---

## 11. Owner decisions

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

# GP-04 — diagnosis, classification, and the remediation evidence

Phase 8. Written before any retrieval code, embedding, taxonomy row, or floor value was
changed, which was the point: GP-04 is the single failing case standing between the taxonomy
and promotion, and every available remedy costs something irreversible.

- **Corpus**: 328 aliases, 295 embedded, `gemini-embedding-001` @ 768 dims.
- **Instrument**: evaluator v2, fixture `taxonomy-retrieval-v1` v2, k=5, alias overfetch 8.
- **Baseline**: `EXP-P8-BASELINE` — R@1 99.1% (112/113), MRR 0.996, 0 errors, 0 empty.

## The case

```
GP-04  jd_nco_7223_6002  paraphrase_latin
       "keeping the coolant level right on the turning machine"
       expected  skill_coolant_management   (provisional, 2 aliases)
       resolved  skill_turning              (active, 5 aliases)  0.7031
```

`skill_turning` became retrievable in this domain when Gate B embedded the shipped catalogue
at 09:41. Before that the case passed. The regression is real and is caused by the corpus
becoming *more* complete, which is the direction production must move in.

## Ablations

Each row changes exactly one thing about the query. Scores are cosine against the
active+provisional scope, where the expected skill actually lives.

| # | Query | Top-1 | Score | Correct |
|---|---|---|---|---|
| GP-04 | keeping the coolant level right **on the turning machine** | `skill_turning` "CNC turning" | 0.7031 | ✗ |
| A1 | keeping the coolant level right | `skill_coolant_management` "coolant top up" | 0.7385 | ✓ |
| A2 | the turning machine | `skill_turning` "turning" | 0.8079 | ✓ |
| A3 | keeping the coolant level right **on the CNC machine** | `skill_coolant_management` | 0.6711 | ✓ |
| A4 | coolant top up *(an existing alias, verbatim)* | `skill_coolant_management` | 1.0000 | ✓ |

Read together:

- **A1** — with the machine clause removed the correct skill wins by 0.21. The coolant concept
  is not weakly represented; it is well separated.
- **A2** — the machine clause on its own resolves correctly too. Neither half is broken.
- **A3** — naming a machine that is *not* a competing skill's alias restores the right answer.
  So the failure needs the literal token `turning`, not the idea of a lathe.
- **A4** — an existing alias embedded as a query returns its own stored vector exactly. The
  vectors are sound and the offline simulation below is exact rather than approximate.

## Classification

**Alias-quality defect, surfaced by a two-concept query.** Not a fixture error, not taxonomy
overlap, not a retrieval misconfiguration, and not an unavoidable semantic limitation.

The evidence against each of the alternatives:

- *Fixture / ground truth* — the query is natural and its head phrase is unambiguously coolant
  work. A1 shows the expected answer wins decisively once the trailing context is dropped.
  Editing the ground truth here would be recording a model failure as an opinion, which is
  the DC-18 mistake repeated.
- *Taxonomy overlap* — coolant management and turning are genuinely distinct skills. What
  collides is a context word in the query and a competitor's alias string, not the concepts.
- *Retrieval configuration* — the scoping, floor, and overfetch all behave as specified. One
  configuration observation stands (see below) but it does not cause this case.
- *Unavoidable ambiguity* — refuted by construction: adding one natural alias fixes it while
  breaking nothing.

The actual defect is that `skill_coolant_management` is labelled **"Coolant management"** and
carries exactly two aliases, `coolant top up` and `कूलेंट भरना` — both of which denote *adding*
coolant. Nothing in its alias set expresses *maintaining a level*, which is what the query
asks about. Meanwhile the competitor carries five aliases including the bare token `turning`.

## The systemic finding

The skill's own canonical label is not among its aliases. That turned out not to be a quirk:

> **119 of 131 skills reachable through an active edge (90.8%) do not carry their own
> `label_en` as an alias.** 98 lack their `label_hi`.

A skill the retriever cannot match on its own canonical name is a defect whether or not a
fixture case happens to expose it. This reframes GP-04 as one visible instance of a repo-wide
alias gap.

## `EXP-P8-CANONICAL-LABEL` — the one-variable experiment

Simulated change, derived mechanically and never authored against a failing case: for every
skill whose `label_en` is absent from its alias set, add that label as one alias.

Run offline via `pnpm db:experiment:alias --run --include-provisional`. Nothing is embedded
and nothing is written; the simulation is exact because of A4.

```
candidates            119
Recall@1              99.1%  ->  100.0%
fixed                 1   (GP-04)
broken                0
lifted over the floor 7
dropped below floor   0
truncated out of window 0
RECOMMENDATION: ACT
```

The seven lifted cases are correct answers that were resolving *below* the 0.75
canonicalization floor — right, but unassignable in production:

| case | before | after | skill |
|---|---|---|---|
| PA-12 | 0.7051 | 0.8471 | `skill_wall_plumb_and_level_checking` |
| AL-01 | 0.6778 | 0.8385 | `skill_material_handling_equipment_operation` |
| GP-02 | 0.6860 | 0.8113 | `skill_refrigerant_leak_detection` |
| PA-03 | 0.7482 | 0.7856 | `skill_mortar_mixing` |
| GP-05 | 0.6933 | 0.7784 | `skill_first_piece_approval` |
| PA-04 | 0.6938 | 0.7704 | `skill_weld_bead_inspection` |
| GP-06 | 0.7148 | 0.7593 | `skill_cutting_tool_selection` |

### Residual risk, stated plainly

GP-04's repaired score is **0.7509** — nine ten-thousandths above the floor. It clears
`RESOLVABLE_ABOVE_FLOOR` and would clear it by almost nothing. Two natural aliases measured
better in a separate hand-authored probe (`cutting fluid management` 0.7787, `coolant level
monitoring` 0.7751), and neither stole any case. They are **not** recommended here, because
strings chosen after reading a failing case are indistinguishable from fitting the metric. The
durable fix for a thin margin is broader alias coverage authored by a domain reviewer.

## Adversarial review of the experiment itself

Three defects were found in the simulation before its result was trusted:

1. **`acceptable_skill_ids` ignored.** The first pass judged against `expected_skill_id` alone
   and reported AL-01 as fixed. AL-01 resolves to `skill_forklift_operation`, which the fixture
   explicitly accepts — so the "fix" was for a case that was never broken. Corrected; the fixed
   count fell from 2 to 1.
2. **Truncation unmodelled.** Max-pooling over every in-scope alias cannot see a skill pushed
   out of the `k × 8 = 40` row window by the added density. Measured directly: the largest
   in-scope alias set after the change is 48 rows and the worst accepted-skill alias-rank is 1
   (3 before). Zero cases truncated, with wide margin.
3. **Partial results could pass as complete.** With the provider refusing calls, the harness
   would have summarised whatever subset succeeded. `--offline` now throws on a cache miss.

Mutation testing of the decision logic: **13 of 14 killed**. The survivor (A06, removing the
window slice in `topSkill`) is an equivalent mutant — sorting precedes slicing, so no window
can change the top-1. The code comment claiming otherwise was wrong and has been corrected;
truncation is asserted against `after_rank` instead.

## Coverage gap

Measured during Phase 8 analysis against the live corpus. No experiment id: this is a property
of the fixture and the catalogue, not a run with a metric to compare across instruments.

| | |
|---|---|
| reachable skills (active edge) | 131 |
| exercised by the fixture | 65 (49.6%) |
| **dark** | 66 |
| **active/shipped skills exercised** | **4 of 30** |

Gate B embedded 98 aliases for the shipped catalogue and the fixture barely tests it.

> **Correction (Phase 8, second pass).** An earlier revision of this document reported alias
> counts of 54, 32, 24 and 18 for `skill_measuring_instruments`, `skill_gdt_reading`,
> `skill_cad_interpretation` and `skill_bench_fitting`. Those were wrong: the query counted
> aliases through a join on `job_domain_skill`, so each alias was counted once per domain the
> skill is wired to (54 = 6 aliases × 9 domains). The true figures are **6, 4, 4 and 3**. No
> skill in the corpus has more than **6** aliases and the mean is **2.25**.
>
> The correction runs against the argument it was originally used for. These are not
> well-covered skills whose absence from the fixture is merely an oversight — the whole corpus
> is thin, which makes the 90.8% missing-canonical-label finding above more serious, not less.

Authoring those cases is deliberately **not** done here. The mechanically safe cases —
query = an existing alias — are also the least informative, and the run already warns that
44.7% of queries are exact-alias hits, "a floor under R@1 that retrieval did not earn". The
cases worth having are paraphrases, and paraphrase ground truth authored by whoever is being
measured is how DC-18 happened. This needs a domain reviewer.

## Operational finding: one text per request

The eval and experiment harnesses `POST /embeddings/skill-alias` with a single text per call,
so a 232-text experiment costs 232 provider **requests**. The corpus embedder batches 100 and
spends ~92 requests for 9,121 aliases. The per-day request ceiling is therefore reached by the
small job, not the large one — Phase 8 exhausted it mid-run and the harness could not finish.

The Phase 6 backoff behaved correctly throughout: bounded retries, `rate_limited: true`, rows
left unembedded, no storm. Two mitigations are in place: `AI_EMBED_TEXTS_PER_MINUTE` pacing,
and a content-addressed, model-keyed embedding cache (`.embed-cache/`, gitignored) so a re-run
costs nothing. Batching the query embeds is the real fix and is not attempted here.

## What this does not change

The floor stays at 0.75. `NO_REGRESSION` is untouched. No skill is promoted, canonicalization
stays off, and the remaining 4,071 domains stay unauthorized. Acting on the recommendation
above means writing 119 alias rows and embedding them — an irreversible corpus change that
requires its own authorization.

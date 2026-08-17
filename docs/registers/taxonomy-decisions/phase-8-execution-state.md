# Phase 8 — execution state and the alias write manifest

Third addendum to [`phase-8-taxonomy-decisions.md`](./phase-8-taxonomy-decisions.md), after
[`phase-8-dependency-findings.md`](./phase-8-dependency-findings.md). Nothing applied; no
provider call made.

---

## 1. Correction: `is_searchable = false` does NOT hide a skill alias from retrieval

This corrects a recommendation made in the decision register — demoting `fitting` and `gauge`
by clearing `is_searchable` would not have done what it claims.

The flag is load-bearing on **`job_domain_alias`**, whose HNSW index is partial
(`WHERE is_searchable`), and `nearestDomains` carries the matching predicate deliberately.

`skill_alias` is a different table with different indexes:

| | `job_domain_alias` | `skill_alias` |
|---|---|---|
| HNSW index | partial, `WHERE is_searchable` | **not partial** — `USING hnsw (embedding vector_cosine_ops)` |
| retrieval predicate | `WHERE a.is_searchable` | **absent** in `canonicalAliasRows`, `legacyAliasRows` and `CANONICAL_RETRIEVAL_SQL` |
| what the flag governs | index use **and** visibility | the partial UNIQUE index only |

So clearing the flag on a `skill_alias` row removes it from
`(skill_id, text_norm, lang) WHERE is_searchable` and leaves it fully retrievable. The bare
tokens would keep winning exactly the matches they were demoted for.

### Three ways to actually demote, and what each costs

| option | removes from retrieval | preserves | cost |
|---|---|---|---|
| **A** — `embedding = NULL` | yes (`sa.embedding IS NOT NULL` is filtered) | row, id, text, `embedded_at` | vector destroyed; restoring needs a re-embed and therefore quota |
| **B** — `DELETE` | yes | nothing | destroys provenance; rejected |
| **C** — add `AND sa.is_searchable` to both retrieval paths | yes | everything | a production retrieval change: two paths in `skills.repository.ts`, `CANONICAL_RETRIEVAL_SQL`, and the byte-for-byte divergence pin |

**Recommended: C, as its own PR, before the demotion.** It makes the flag mean the same thing on
both alias tables, which is what a reader already assumes, and it is the only option that is
reversible without spending quota. Phase 6 established that the scoped skill query never uses
HNSW at this corpus size — the planner seq-scans and sorts exactly — so adding the predicate
cannot cost an index path it was not using.

**Not recommended: A as a shortcut.** It is reversible only in principle; in practice the
re-embed needs provider budget, which is the resource currently blocking this whole phase.

Until C lands, `fitting` and `gauge` stay as they are. Demoting them with a flag that retrieval
ignores would be worse than not demoting them, because the register would record the hazard as
closed.

---

## 2. TD-05 — DEFERRED, with the keyword table as additional evidence

Per instruction, `skill_fixture_setup` and `skill_tool_offset_setting` remain **separate
skills**. No merge into `skill_cnc_setup`. The existing keyword mapping is untouched.

The evidence for keeping the split is stronger than "no JD data yet". The profiling keyword
table is explicitly ordered so that a general term cannot shadow a specific one:

> *"ORDER IS LOAD-BEARING and must not be sorted: a generic term must never shadow a specific
> one. `tool offset` precedes `offset` so that 'tool offset setting' keys the specific skill,
> and both map to the same taxonomy id on purpose."*
> — `packages/profiling-lexicon/src/internal/data.generated.ts`, generated from `signals.py`

Someone previously encountered this exact ambiguity and resolved it by ordering rather than by
merging. That is operational evidence that the distinction is real and in use, and it should be
overturned only by JD evidence that says otherwise — not to simplify retrieval.

**Consequence for the alias queue:** `offset lagana → skill_tool_offset_setting` is now
**unblocked**, because its target skill survives.

---

## 3. Cross-team execution — option (a), issues raised

| surface | issue | scope |
|---|---|---|
| AI | **#935** | `lexicon_data/skills.json:21-23`, `miss_attribution.py:67`, `signals.py:1963`, `canonicalization_gold.py:202` |
| Mobile | **#936** | `taxonomy_labels.dart:32,44,49,50` |

Both are marked *blocks the Backend taxonomy merge; do not merge independently.* TD-05 being
deferred removed `skill_fixture_setup` and `skill_tool_offset_setting` from both issues, which
cuts the AI blast radius to the `skill_gdt_reading` cluster.

No merge-queue is configured on this repository, so the three PRs must be landed in a
coordinated sequence: **AI + Mobile ready and approved → Backend merges → AI and Mobile merge
immediately after.** No intermediate state on `origin/main` may have a dissolved id still
referenced.

---

## 4. Alias write manifest — prepared, NOT executed

13 additions, all pre-checked against every existing alias: no collisions, no missing target
skills. Language is `en` unless the text is Devanagari.

| # | text | skill | lang |
|---|---|---|---|
| 1 | `CO2 welding` | `skill_mig_welding` | en |
| 2 | `CO2 वेल्डिंग` | `skill_mig_welding` | hi |
| 3 | `patra` | `skill_sheet_metal` | en |
| 4 | `पतरे का काम` | `skill_sheet_metal` | hi |
| 5 | `M70` | `skill_mitsubishi` | en |
| 6 | `M80` | `skill_mitsubishi` | en |
| 7 | `828D` | `skill_siemens` | en |
| 8 | `840D` | `skill_siemens` | en |
| 9 | `thread marna` | `skill_tapping_threading` | en |
| 10 | `hydraulic ka kaam` | `skill_hydraulics_pneumatics` | en |
| 11 | `assembly ka kaam` | `skill_mechanical_assembly` | en |
| 12 | `असेंबली` | `skill_mechanical_assembly` | hi |
| 13 | `offset lagana` | `skill_tool_offset_setting` | en |

**Fanuc model aliases: NONE.** Every Fanuc reference in the repository is `fanuc`, `Fanuc`,
`Fanuc controller` or `skill_fanuc`; no model number exists anywhere, so none can be added on
evidence. Dropped, not pending.

Rollback is by the captured id set only, never by text:

```sql
-- Rollback: delete exactly the rows this write created.
-- Ids come from the RETURNING clause of the insert, persisted to the manifest before commit.
DELETE FROM skill_alias WHERE id = ANY($1::uuid[]);
```

The rows are inserted **unembedded** (`embedding IS NULL`), so the write and the embed stay
separately attributable and separately authorized. Retrieval filters
`sa.embedding IS NOT NULL`, so an inserted-but-unembedded alias changes no retrieval result —
the alias write is therefore behaviourally inert until the embed is authorized.

---

## 5. State

| item | state |
|---|---|
| Cross-team issues #935, #936 | **DONE** |
| TD-05 | **PENDING HUMAN REVIEW** — kept split; keyword-table evidence recorded |
| TD-01, TD-02, TD-03 | **AWAITING AUTHORIZATION** — blocked on #935 + #936 landing together |
| TD-01 `technical drawing` term | **BLOCKED** — unresolved, not guessed |
| TD-04, TD-06, TD-07 | **PENDING HUMAN REVIEW** |
| 13 alias additions | **AWAITING AUTHORIZATION** — manifest above |
| `fitting` / `gauge` demotion | **BLOCKED** — needs the retrieval-predicate change (§1 option C) first |
| Fanuc model aliases | **DROPPED** |
| Canonical labels 84 → 81 | **AWAITING AUTHORIZATION** — recompute after merges |
| 52 paraphrase slots, 35 REVIEW labels | **PENDING HUMAN REVIEW** |
| Embedding, fresh evaluation | **BLOCKED** — provider daily quota exhausted |
| Promotion, canonicalization, 4,071 domains | **NOT AUTHORIZED** |

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

**Not recommended: A as a shortcut.** It is reversible only in principle; in practice the
re-embed needs provider budget, which is the resource currently blocking this whole phase.

### Option C was implemented, measured, and REVERTED — it destroys retrieval

C was authorized and built: the predicate on both paths, the harness constant, per-path
divergence pins, and regression tests. Every test passed. It was then verified against the live
corpus inside a rolled-back transaction, and the verification refuted it.

```
skill_alias                       328 rows
  text_norm populated             197
  is_searchable = true            197   <- exactly the same rows
  is_searchable = false           131

embedded aliases by skill status
  provisional   197 embedded,   0 hidden
  active         98 embedded,  98 hidden   <- ALL of them
```

`is_searchable` **defaults to `false`** and nothing maintains it for `skill_alias`. The
normalizer that computes it (`db:normalize:aliases`) targets `job_domain_alias`; the 131 rows
with no `text_norm` were never processed, and that set contains **every one of the 98 aliases
Gate B embedded**.

Shipping the predicate would have made **all 30 active skills completely unreachable** — the
entire shipped catalogue, silently, with a green build.

The codebase already knew. `skills.repository.ts` records that migration 0076 deliberately left
`skill_alias_embedding_hnsw` non-partial because *"a `WHERE is_searchable` predicate would have
unindexed all 131 live rows."* The change would have inflicted exactly the harm the original
authors declined to inflict.

### What the fix actually is

The gap is real — the flag means "retired from retrieval" on one alias table and nothing on the
other — but the predicate is the last step, not the first:

1. **Maintain the projection for `skill_alias`.** Populate `text_norm` and compute
   `is_searchable` across all 328 rows, as `normalize-job-domain-aliases.ts` does for domain
   aliases. Until that runs, the flag carries no information about this table.
2. **Verify** the 98 Gate B aliases come out searchable and the intended demotions do not.
3. **Then** add the predicate, with the per-path pins.

Steps 1–2 are a runner plus a data pass and are safe to build. Step 3 stays blocked on them.

Until then `fitting` and `gauge` stay as they are — and more importantly, **`is_searchable =
false` on a skill alias should not be read as meaning anything today.** It mostly means
"inserted after the last normalizer run".

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
| Retrieval-predicate change (authorized) | **REVERTED** — would hide all 98 active-catalogue aliases; see §1 |
| `skill_alias` text_norm / is_searchable normalizer | **NOT STARTED** — prerequisite for the predicate |
| TD-05 | **PENDING HUMAN REVIEW** — kept split; keyword-table evidence recorded |
| TD-01, TD-02, TD-03 | **AWAITING AUTHORIZATION** — blocked on #935 + #936 landing together |
| TD-01 `technical drawing` term | **BLOCKED** — unresolved, not guessed |
| TD-04, TD-06, TD-07 | **PENDING HUMAN REVIEW** |
| 13 alias additions | **AWAITING AUTHORIZATION** — manifest above |
| `fitting` / `gauge` demotion | **BLOCKED** — option C measured and reverted; needs a `skill_alias` normalizer first (§1) |
| Fanuc model aliases | **DROPPED** |
| Canonical labels 84 → 81 | **AWAITING AUTHORIZATION** — recompute after merges |
| 52 paraphrase slots, 35 REVIEW labels | **PENDING HUMAN REVIEW** |
| Embedding, fresh evaluation | **BLOCKED** — provider daily quota exhausted |
| Promotion, canonicalization, 4,071 domains | **NOT AUTHORIZED** |

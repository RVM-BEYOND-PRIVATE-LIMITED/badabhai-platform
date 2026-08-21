# D-5 — the 96 non-title `job_domain.label_en` rows and their 206 aliases

**Measured 2026-08-21 · main `0db268e3` · read-only · production mutation NONE · AI spend ₹0**

Every number below came from a `SELECT` on a session where
`default_transaction_read_only = on`, as role `postgres` with `rolbypassrls = true`.
Both facts matter and are stated for a reason — see §0.

Reproduce: `pnpm db:audit:junk-labels --json=<out>`

> **Provenance, stated plainly.** Every figure below was measured by read-only SQL against
> production. The committed audit script reproduces those queries, but **it has not yet emitted
> its JSON artifact** — the Supabase pooler saturated
> (`EMAXCONNSESSION … pool_size: 15`) after the measurements were taken and before the script
> could run, across three attempts. Pooler configuration was not touched. The script is
> committed, typechecked and unit-tested; `d5-junk-label-audit.json` is **owed** and is one
> command away once capacity frees. Where a number below is the classification *rule* applied
> to a measured input rather than script output, §3 says so.

Each claim is tagged:
**[CODE]** what the code does today · **[DATA]** what production holds today ·
**[DESIGN]** what the taxonomy intends · **[REC]** what I recommend, deciding nothing.

---

## 0. Two ways this investigation could have produced a confident wrong answer

**RLS.** `job_domain`, `job_domain_alias`, `job_domain_skill`, `worker_profiles`,
`job_postings`, `unresolved_phrase` and `profiling_family_binding` are all
`FORCE ROW LEVEL SECURITY` with **zero policies**. A role without `BYPASSRLS` reads every one
of them as empty and would report "0 references — safe to delete" about a table it was simply
not permitted to see. **[DATA]** The measuring role has `rolbypassrls = true`, so the zeros
below are real. The audit prints this and withholds reference counts when it is false.

**A missing table.** A table declared in the schema may not exist in the target. That is
reported `UNKNOWN`, never folded into zero.

---

## 1. The population reproduces exactly

**[DATA]**

| | |
|---|---:|
| `label_en` ending `:` (section headers) | **18** |
| `label_en` starting lowercase (prose fragments) | **78** |
| **total** | **96** |
| …of 4,071 `job_domain` rows | 2.36 % |
| alias rows on them | **209** |
| …on the retrieval surface (`is_searchable`) | **206** |
| …**embedded, i.e. live in the ANN index** | **206** |
| 206 as a share of the 5,086-row searchable surface | **4.05 %** |

All 96 are `source = nco2015`, `level = 5`, `status = active`, `selectable = true`, and
**none has a child**. The 3 non-searchable alias rows are duplicate-election losers — the
mechanism `is_searchable` exists for, working as designed.

**[DATA]** Every one of the 96 carries a published NCO code. Not by observation but by
constraint: `job_domain_source_code_chk` is `source = 'rvm' OR source_code IS NOT NULL`, and
all 96 are `nco2015`. **These are published occupations, not invented rows.**

### What they actually are

**[DATA]** NCO-2015 PDF scrape residue, in exactly two shapes:

- **Section headers** captured as the occupation name — `"ISCO 08 Unit Group Details:"` on
  **12** distinct domains, `"Qualification Pack Details:"` on **4**,
  `"Occupations in this Group are classified into the following Families:"` on **2**.
- **Wrapped continuation lines** of a description — e.g. `jd_nco_8155_0201` =
  `"skins or hides and keeps them near machine; spreads skin or hide with hair"`. The scraper
  took line *n+1* of a paragraph as the title.

---

## 2. References: zero, everywhere, and the zeros are readable

**[DATA]**

| table | rows referencing the 96 | note |
|---|---:|---|
| `job_domain_skill` | **0** | |
| `worker_profiles` | **0** | see §5 — the table holds 1 row total |
| `job_postings` | **0** | table holds 8 rows |
| `unresolved_phrase` | **0** | table holds 37 rows |
| `profiling_family_binding` | **0** | table holds 101 rows, **`job_domain_id` is NULL on all of them** |
| child domains | **0** | all 96 are leaves |

That last row is the one worth reading twice. `profiling_family_binding` is populated and in
use, but binds by ISCO code, not by domain id — **no binding anywhere names a `job_domain_id`**.
So "0 bindings on junk domains" is true of the whole table, not a property of these 96.

**[DATA]** `profiling_family_binding` is singular in both the schema and the database. An
earlier draft of my own query used the plural and got "relation does not exist"; that was my
error, **not** schema drift, and nothing here reports one.

---

## 3. Classification of the 96 domains

Rule (deterministic, most-protective first): any reference → `B`; any child → `D`; a published
code **and** at least one title-shaped alias → `C`; no code **and** no alias → `A`; otherwise
`E`.

| class | count | meaning |
|---|---:|---|
| **C — mislabelled but legitimate** | **88** | a real coded occupation whose `label_en` caught the wrong line. **Rename, never remove.** |
| **E — ambiguous** | **8** | coded, but no alias reads as an occupation. Owner review. |
| A — unused junk | **0** | |
| B — legacy referenced | **0** | |
| D — structural | **0** | |

**How this table was derived.** The three inputs are measured: references = 0 for all 96 (§2),
children = 0 for all 96 (§1), and **88 of 96 domains have ≥1 title-shaped alias** while 8 have
none (§4). A published code is guaranteed for all 96 by CHECK constraint. Applying the rule to
those inputs gives 88 `C` and 8 `E`, with `A`, `B` and `D` necessarily empty — `B` and `D`
because their triggers measured zero, `A` because it requires the absence of a code, which the
constraint forbids. The committed script computes exactly this and will print it directly once
the pooler frees; the split is not an estimate, but it is a rule applied by hand to measured
inputs rather than script output.

**The headline finding is that Class A is empty.** Not one of the 96 is disposable junk. The
label is residue; the occupation underneath it is a published NCO row with a code and, in 88
cases, worker-vocabulary aliases that already work.

**[REC]** The 8 `E` rows are not deletion candidates either — they hold a published code, so
the honest description is "an NCO occupation whose scrape produced no usable name". That is a
re-scrape task, not a cleanup task.

---

## 4. Aliases — and the one that actually causes harm

**[DATA]** Of the 206 searchable aliases: **119** are title-shaped, **78** start lowercase,
**18** end with a colon, **20** exceed 80 characters. **88 of 96 domains have at least one
title-shaped alias**; 8 have none.

**[DATA]** Four `text_norm` values reach more than one domain:

| normalized text | domains | composition |
|---|---:|---|
| `isco 08 unit group details` | 12 | all 12 junk |
| `qualification pack details` | 4 | all 4 junk |
| `occupations in this group are classified…` | 2 | both junk |
| **`cable jointer`** | **2** | **one junk, one clean** |

The first three are junk-on-junk: they make 18 scrape headers mutually ambiguous, which is
noise, not a wrong answer about a real trade.

**`cable jointer` is different and is the concrete defect of this investigation.**

```
jd_nco_7413_9900  "Electrical Line Installers, Repairers and Cable Jointers, Other"   ← the real one
jd_nco_7422_0800  "ISCO 08 Unit Group Details:"                                        ← scrape residue
```

Both carry a searchable, embedded alias normalizing to `cable jointer`. **[CODE]** Both are
therefore in the retrieval index (§5), so a worker who says "cable jointer" can be resolved to
a domain whose entire identity is a scrape header. This is the only junk↔clean collision in
the corpus.

**[REC]** `TYPO` and `LEGACY_ALIAS` are **not** decided. A typo needs the intended spelling and
a legacy title needs supersession history; neither is derivable from the columns available, and
inventing a heuristic would manufacture confidence. Those rows sit in `AMBIGUOUS` deliberately.

---

## 5. Runtime impact — traced, not assumed

**[CODE]** The occupation index is built from two queries in
[occupation.repository.ts](../../../apps/api/src/occupation/occupation.repository.ts):

```
loadDomains()  WHERE selectable = true AND status = 'active'   -> all 96 ARE in the index
loadAliases()  WHERE is_searchable                              -> all 206 ARE in the surface
```

**So these rows are not authoring-only. They are live retrieval targets today.**

**[CODE]** But the junk *label* does **not** reach the worker. `pickChipLabel`
([occupation-index.ts:111](../../../apps/api/src/occupation/occupation-index.ts#L111)) resolves
`labelHi` → shortest non-official alias → family label → `labelEn`. Since **all 96 have at
least one searchable alias**, the `labelEn` branch is unreachable for every one of them. The
chip a worker sees is an alias.

Where the label *does* surface:

| surface | carries `label_en`? | **[CODE]** |
|---|---|---|
| `POST /internal/occupation/resolve` → `candidates[].label` | **no** — `chipLabel` | `occupation.service.ts:257` |
| `GET /internal/occupation/domain/:id` → `label_en` | **yes, verbatim** | `occupation.controller.ts:138` |
| ops logs / records | yes | by design — `labelEn` is kept as the stable official name |

**[DATA]** Match path: `worker_skill` and `job_reach` are **empty (0 rows)**, and
`job_domain_skill` holds no edge on any of the 96. Combined with D-1's finding that
`job_domain_skill` has no runtime reader, **no junk domain reaches `mskill_*`, `job_reach`, the
feed, or the candidate list.**

**[REC]** Frontend: I did not find hardcoded `jd_nco_*` ids in client code, but I did not
exhaustively sweep every app, so I am not asserting their absence. Treat that as **not
measured**, not as zero.

---

## 6. A discrepancy that must not be inherited quietly

Two documents on record make worker-side claims that **do not reproduce today**.

| claim | source | **[DATA]** measured now |
|---|---|---|
| "a live worker is currently matched to `jd_nco_8155_0201`" | coverage report §3.4 | `worker_profiles` rows on it: **0** |
| "`worker_profiles.job_domain_id` — 19 of 44 populated" | `d1-runtime-path-trace.md` | `worker_profiles`: **1 row**, `job_domain_id` **NULL** |
| "`worker_skill` — 8 rows, 6 workers" | `d1-runtime-path-trace.md` | **0 rows** |
| "`job_reach` — 6 rows, 1 posting" | `d1-runtime-path-trace.md` | **0 rows** |

`workers` holds **1** row. `job_postings` holds 8; `unresolved_phrase` 37; the taxonomy tables
are untouched (`job_domain` still 4,071, `job_domain_alias` still 9,121).

**[DATA]** `_delete_forensics` records deletions of `workers` and `worker_profiles` rows with
`db_user = postgres`, `app_name = supabase/dashboard` — i.e. manual deletion through the
Supabase dashboard. The rows I sampled are dated **2026-08-13**, which is *before* the D-1
trace was written, so they do not by themselves explain the change.

**I cannot reconstruct when the worker data went away, and I am not going to guess.** What is
established: the worker-side row counts in both earlier documents are **stale**, and the
specific claim that a live worker is pinned to a junk-labelled domain **is not true of the
current database**. The taxonomy-side findings in those documents are unaffected.

**[REC]** Treat every worker/match row count in those two documents as needing re-measurement
before it is used to justify anything.

---

## 7. Remediation matrix — a decision surface, not a plan

**Nothing was changed.** No `DELETE`, `UPDATE`, rename, status change, de-election, promotion,
or gate/baseline edit. The audit's own notice: *"a label defect is not evidence that the
occupation beneath it is disposable."*

| group | n | runtime refs | children | aliases | **[REC]** |
|---|---:|---:|---:|---:|---|
| C — mislabelled, coded, has usable alias | 88 | 0 | 0 | ≥1 title-shaped | **Rename `label_en`** from the NCO source or the best alias. Retrieval is unaffected either way — the label is not the search key. |
| E — coded, no usable alias | 8 | 0 | 0 | prose only | **Owner review.** Re-scrape the NCO title. Do not remove. |
| `cable jointer` collision | 1 alias | — | — | — | **De-elect the junk side** (`jd_nco_7422_0800`) exactly as the D2 de-collision precedent did: null the losing embedding, keep the row. |
| headers colliding with each other | 18 aliases | — | — | — | Low priority. Junk-on-junk ambiguity misroutes nobody to a real trade. |

**[REC]** Sequencing: the `cable jointer` de-election is the only item with a live relevance
consequence and is the smallest. The 88 renames are cosmetic-plus-ops and can ride any later
corpus write. None of this is urgent, and none of it should be bundled into a promotion.

---

## 8. Relationship to Q1 — reported, not solved

**[DATA]** The 96 junk-labelled *domains* and the 96 promotable *skills* from TASK 9B are
**unrelated populations that happen to share a count**. The domains carry zero
`job_domain_skill` edges, so no promotable skill is attached to any of them.

The 9B finding stands unchanged: 96/96 promotable skills are outside `SKILL_CORPUS`. **Nothing
in D-5 adds a `SKILL_CORPUS` entry, an `ATTRIBUTE_TO_MATCH_SKILLS` mapping, or any matching
change.** Q1 remains an owner decision.

---

## 9. Gates — unchanged

```
GATE_ACCEPTED / IS_PROVISIONAL / ACTIVE_EDGE / FULLY_EMBEDDED / EVAL_COVERED    96 PASS
RESOLVABLE_ABOVE_FLOOR                                                          FAIL 62/96
NO_REGRESSION                                                                   FAIL
PROMOTION CANDIDATES                                                            0
```

The 0.75 floor, `REGRESSION_BASELINE`, and every gate semantic are untouched. No evaluation or
sweep was rerun. **AI spend: ₹0.**

---

## 10. Tripwires added

Both encode an invariant this investigation established, and neither is a gate on promotion:

1. **A coded occupation can never be classified `A_UNUSED_JUNK`.** The rule requires the
   identity to be unrecoverable; a published NCO code makes it recoverable by definition. This
   is the mistake that would lose data, so it is pinned in a test.
2. **A cross-domain alias collision is `CONFLICTING_ALIAS` regardless of how well-formed the
   text is** — good shape must not mask a live competition for a worker's phrase.

# Phase 9 — Master Execution Plan

> **Status: PLAN ONLY.** Nothing in this document has been executed. No database mutation,
> no provider call, no election, no predicate, no canonicalization.
> Measured against `origin/main` and the live dev corpus on **2026-08-18**.

---

## 0. How to read this document

Three words are used strictly and never interchangeably:

| Term | Meaning | Mutable? |
|---|---|---|
| **EVIDENCE** | A measurement of a state that existed. Immutable once written. | Never |
| **PROPOSED** | A computed plan for a state that does not exist. | Regenerate to a new path |
| **APPLIED** | The state of the live corpus right now. | Only via an authorized mutation |

An artifact that mixes two of these is a defect. `skill-alias-election-manifest-PROPOSED.json`
carries `PROPOSED` in its filename and a `status` field for exactly this reason.

---

## 1. Current state — measured, not recalled

### 1.1 Corpus

| Object | Count | Note |
|---|---:|---|
| `skill` | 146 | 33 active, 113 provisional, 0 deprecated |
| `skill` reachable via an active `job_domain_skill` edge | 131 | |
| **active skills with NO active edge** | **3** | `skill_welder_occupation`, `skill_fitter_occupation`, `skill_machinist_occupation` |
| `skill_alias` | 328 | |
| ├ `text_norm` populated | 328 | ✅ Phase 8 normalization write |
| ├ embedded | 295 | 33 provisional aliases unembedded |
| └ `is_searchable` | 197 | unchanged since before normalization |
| `job_domain` | 4,071 | **the domains already exist** |
| ├ selectable + active | 3,885 | |
| ├ with ≥1 skill edge | **28** | |
| └ with no skill edge | **4,043** | |
| `job_domain_skill` edges | 238 | |
| `job_domain_alias` | 9,121 | |
| ├ `text_norm` populated | **0** | |
| ├ embedded | **0** | |
| └ `is_searchable` | **0** | |

### 1.2 Fixture

`retrieval-v2.jsonl` — **127 cases**, 65 distinct expected skills.
By provenance: **88 reviewed**, **39 mechanical** (`corpus_alias:*`).
`review_status` is *derived* from provenance, not stored.

Review pack (`uncovered-active-skills.json`): **26 dark active skills**, **115 evidence
questions**, **103 proposed cases** = 51 mechanical + **52 empty paraphrase slots**.

> The "51 mechanical" figure refers to *proposed* cases in the review pack. The *fixture*
> contains 39. Both are correct; they count different things. Do not conflate them.

### 1.3 Immutable evidence register

| Artifact | Kind | Identity |
|---|---|---|
| `EXP-P8-BASELINE` | EVIDENCE | R@1 **0.9912**, R@3 1.0, R@5 1.0, MRR **0.9956**, evaluator v2, fixture v2, `2026-08-17T11:32:00.061Z` |
| `EXP-P8-CANONICAL-LABEL` | EVIDENCE | R@1 100.0%, fixed 1, broken 0 |
| `EXP-BASELINE`, `EXP-EVAL-CORRECTION`, `EXP-ANN-*` | EVIDENCE | Phase 5/6/7 |
| `skill-alias-text-norm-manifest.json` | EVIDENCE (pre-write) | sha256 `ef00c229…6bbb`, 131 rows |
| `skill-alias-post-normalization-verification.json` | EVIDENCE (post-write) | sha256 `428fa209…ad4d` |
| `skill-alias-election-manifest-PROPOSED.json` | **PROPOSED** | sha256 `e0f9ebeb…9741`, 131 rows |
| `canonical-label-candidates.json` | EVIDENCE | 119 candidates: 0 BLOCK, 35 REVIEW, 84 OK |
| GP-04 measurements | EVIDENCE | see §9 |

`writeArtifact()` refuses to overwrite any of these. That guard exists because one of them
*was* overwritten during Phase 8 verification and had to be recovered from git.

---

## 2. Dependency graph — corrected

The proposed ordering is **wrong or incomplete in six places**. Corrections are marked ⚠.

```
        ┌──────────────────────────────────────────────────────┐
    ⚠A  │ N0  PROMOTION-GATE REPAIR + FRESHNESS SIGNAL         │  ← missing, and it is FIRST
        └──────────────────────────┬───────────────────────────┘
                                   ↓
        ┌──────────────────────────────────────────────────────┐
    ⚠B  │ N1  job_domain_alias normalize → embed → elect       │  ← missing entirely
        └──────────────────────────┬───────────────────────────┘
                                   ↓
     N2  taxonomy decisions (TD-01…TD-07)  ──── blocked on human evidence
                                   ↓
    ⚠C  N3  AI (#935) + Mobile (#936) merge FIRST   ← reversed from the proposed order
                                   ↓
     N4  backend skill-id / merge changes
                                   ↓
     N5  alias cleanup  +  generic-alias demotions  +  canonical labels
                                   ↓
     N6  normalization  ✅ DONE (328/328)
                                   ↓
     N7  election  ── PROPOSED, not applied
                                   ↓
    ⚠D  N8  fixture v3          ← MOVED UP. Must precede re-baselining, not follow it.
                                   ↓
     N9  retrieval predicate
                                   ↓
    N10  embedding (new aliases only)
                                   ↓
    N11  fresh evaluation → E1…E6 ladder
                                   ↓
    ⚠E  N12  RE-BASELINE NO_REGRESSION against fixture v3   ← missing
                                   ↓
    N13  promotion eligibility
                                   ↓
    N14  canonicalization enablement
                                   ↓
    ⚠F  N15  domain→skill edge generation for 4,043 domains  ← mis-named "4,071-domain generation"
```

### The six corrections

**⚠A — Gate repair must come first, not last.** Every downstream stage produces evidence
that the promotion gates are supposed to judge. If the gates have loopholes (§8, and they
do), every piece of evidence produced between now and promotion is judged by a broken
ruler. Worse, the specific loophole below means the evidence *chain itself* silently breaks
the moment election runs:

```
corpusChangedAt = SELECT max(embedded_at) FROM skill_alias WHERE embedding IS NOT NULL
```

That is the entire freshness signal. It is blind to `text_norm`, to `is_searchable`, to
taxonomy merges, to edge changes, and to alias add/remove. **Election does not touch
`embedded_at`** — so after election, a *pre-election* evaluation record still passes the
staleness check. The comment above that code says it was written because a stale record once
made the gate "report PASS on evidence that could not have seen the regression." The same
failure is reachable today through a different column.

**⚠B — the domain side is not in the graph, and it is upstream of everything.** 9,121
`job_domain_alias` rows: 0 normalized, 0 embedded, 0 searchable. `nearestDomains` filters
`WHERE a.is_searchable` against a **partial** HNSW index, so on this corpus domain retrieval
returns nothing. Skill retrieval is scoped *by* `job_domain_id` — if domain resolution
yields nothing, the canonicalization path is dead regardless of how good the skill aliases
are. *Measured on the local dev corpus; production/Supabase state is **unverified** and is
the first thing to check.* Either way the node belongs in the graph.

**⚠C — AI and Mobile must merge before Backend, not after.** The proposed graph puts
`skill-id / merge changes` above `backend / AI / mobile references`. The stated rule — *no
backend taxonomy merge that leaves AI/mobile references dangling* — requires the opposite
order. #935 and #936 land first; backend follows.

**⚠D — fixture expansion cannot come after re-evaluation.** `judgeRegression` compares
`fixture_version` to the reference and returns *"evaluation used fixture v3 but the
reference is v2"* → **fail**. Not a regression — an inability to compare. So placing fixture
expansion between "fresh evaluation" and "NO_REGRESSION" makes NO_REGRESSION structurally
unpassable, and the only way through would be `--waive NO_REGRESSION`, which is exactly the
outcome the gate exists to prevent.

**⚠E — re-baselining is a distinct, missing step.** Once fixture v3 exists, a new
`REGRESSION_BASELINE` must be *minted from a clean measured run and reviewed as a decision*.
It is a code change with a human sign-off, not a side effect.

**⚠F — "4,071-domain generation" is mis-scoped.** The 4,071 domains already exist as rows.
What does not exist is (a) domain→skill edges for 4,043 of them and (b) any domain-alias
embedding at all. The real cost is ~92 provider requests for the alias corpus plus whatever
edge generation costs. Renaming the node changes its risk profile and its authorization.

---

## 3. Decision matrix

| Decision | Evidence held | Human required | Blocking? | Next action |
|---|---|---|---|---|
| **TD-01** gdt_reading + reading-part of cad_interpretation → `skill_drawing_reading` | Partial. `cad` (bare) is a prefix of `cad drafting` on a *different* skill — two CAD concepts confirmed to exist | **Yes** — term list unresolved (§4) | **Yes** | Resolve `technical drawing`; rule on GD&T; decide bare `cad` |
| **TD-02** quality_control → dimensional_inspection | Partial. `inspection` (bare) shadows 2 other skills | Trainer ratification | Yes | Confirm merge direction + alias cleanup |
| **TD-03** boring → turning | **Sufficient.** `skill_boring` absent from `jd_nco_7223_6002`; single alias `boring` scores 0.5307 @ rank 7 | Ratification only | No | Execute in N4 |
| **TD-04** go_no_go_gauge_checking ↔ measuring_instruments | **Insufficient** — see §4 | **Yes** | Yes | Blocked |
| **TD-05** fixture_setup ↔ tool_offset_setting | **Sufficient — KEEP SPLIT.** Profiling keyword table already orders `tool offset` before `offset`; someone met this ambiguity and solved it by ordering | None | No | **No change.** Do not revisit without new evidence |
| **TD-06** chassis_fitting ↔ mechanical_assembly | **Insufficient** — see §4 | **Yes** | Yes | Blocked |
| **TD-07** generic welding parent/default | **Insufficient** — see §4 | **Yes** | Yes | Blocked |
| Canonical labels 84 OK | Audit complete; simulation only | Authorization | Yes | Re-measure after N4/N5 |
| Canonical labels 35 REVIEW | 34 compound, 1 single-token | **Yes** | Yes | Classify per §7 |
| `finishing` collision | Measured | **Yes** | Yes | §6 |
| `fitting` / `gauge` demotion | Measured; rehearsed safely | Authorization | Yes | After TD-04 |
| Fixture v3 | 52 empty slots, 115 questions | **Trainer** | Yes | §10 |

---

## 4. Missing evidence for TD-04, TD-06, TD-07 — stated precisely

Each of these is **BLOCKED**, not "pending my judgement". No assumption will be recorded.

### TD-04 — `go_no_go_gauge_checking` ↔ `measuring_instruments`

*Missing:* whether employers in the target set hire separately for **attribute** gauging
(go/no-go: pass-fail, no reading taken) versus **variable** measurement (vernier,
micrometer, height gauge: a number is recorded). These are different competencies in
metrology; whether they are different *jobs* here is an employer question.

*Human required:* RVM trade trainer, plus a JD sample.
*Coupled defect:* the bare alias `gauge` sits on `measuring_instruments` and shadows
`go_no_go_gauge_checking`. Whatever the merge decision, that alias must be resolved.

### TD-06 — `chassis_fitting` ↔ `mechanical_assembly`

*Missing:* whether chassis fitting is a distinct hiring category in the target employer mix
or a specialisation of general mechanical assembly.

*Human required:* trainer + employer-mix evidence.
*Coupled defect:* the bare alias `assembly` on `mechanical_assembly` shadows
`chassis_fitting` and `sub_assembly_quality_checking`.

### TD-07 — generic welding parent/default

*Missing:* the **policy** for a bare "welding" utterance. Three defensible answers, and the
choice is a product decision, not an engineering one:
1. resolve to an occupation-level skill,
2. resolve to a parent/umbrella skill that does not exist yet,
3. refuse and route to the unresolved-phrase queue for follow-up questioning.

*Human required:* product + trainer.
*Measured complication:* the bare `welding` (hi) alias sits on `skill_welder_occupation`,
which is **one of the three active skills with no active `job_domain_skill` edge** — so it
is already unreachable through the canonical path. Option 1 therefore does not work today
without also creating an edge.

**Standing instruction honoured:** absence of a generic-welding parent is recorded as a
*taxonomy gap*. Bare "welding" is **not** silently mapped to arc welding.

### TD-01 — explicit term model

Requested terms, modelled rather than collapsed:

| Term | Lang | Proposed target | Status |
|---|---|---|---|
| `read engineering drawings` | en | `skill_drawing_reading` | proposed |
| `blueprint reading` | en | `skill_drawing_reading` | proposed |
| `drawing padhna` | hinglish | `skill_drawing_reading` | **needs trainer** — the actual spoken form must be confirmed, not invented |
| `technical drawing` | en | **UNRESOLVED** | ambiguous between the *artifact* and the *skill of reading it* |
| `GD&T` | en | **UNRESOLVED** | TD-01 merges `gdt_reading` in, but GD&T is a distinct, testable competency; merging may destroy a real signal |
| `CAD` | en | **NOT `skill_drawing_reading`** | bare `cad` currently on `skill_cad_interpretation` and is a prefix of `cad drafting` on `skill_cad_2d_drafting` |

**CAD software usage is not drawing reading, and this plan does not collapse them.**
`skill_cad_interpretation` is the ambiguous node: its *name* says interpretation (reading),
its bare `cad` alias captures software usage. TD-01 must split those two senses explicitly
or it will silently move software-usage traffic into a reading skill.

---

## 5. Generic-alias risk report

Not a duplicate report. Duplicates are exact-match collisions; the larger risk is a **short
alias on one skill that shadows a whole family on other skills**. 45 of the active
catalogue's aliases are single-token.

### A. Exact cross-skill collisions (same `text_norm` + `lang`)

| text_norm | lang | skills |
|---|---|---|
| `finishing` | en | `skill_deburring` (active, embedded) · `skill_furniture_finishing` (provisional, unembedded) |

### B. Single-token aliases that shadow other skills

| alias | lang | owner | shadows | competing skills |
|---|---|---|---:|---|
| **`fitting`** | en + hi | `skill_bench_fitting` (active) | **4** | `pipe_fitting`, `ducting_installation`, `distribution_board_assembly`, `switchgear_installation` |
| **`welding`** | hi | `skill_welder_occupation` (active, **no edge**) | **3** | `arc_welding`, `mig_welding`, `tig_welding` |
| `inspection` | en | `skill_dimensional_inspection` (active) | 2 | `inspection_report_recording`, `visual_defect_identification` |
| `assembly` | en | `skill_mechanical_assembly` (active) | 2 | `chassis_fitting`, `sub_assembly_quality_checking` |
| `gauge` | en | `skill_measuring_instruments` (active) | 1 | `go_no_go_gauge_checking` |
| `finishing` | en + hi | `skill_deburring` (active) | 1 | `furniture_finishing` |
| `cad` | en | `skill_cad_interpretation` (active) | 1 | `cad_2d_drafting` |
| `designer` | en | `skill_designer_occupation` (prov.) | 1 | `interior_designer_occupation` |

### C. Prefix shadowing (an L2/trigram hazard, not an L0 one)

- `cad` (`cad_interpretation`) ⊂ `cad drafting` (`cad_2d_drafting`)
- `inspection` (`dimensional_inspection`) ⊂ `inspection recording` (`inspection_report_recording`)

### The finding that matters

**Every open taxonomy decision has a generic alias sitting on top of it.**

| Decision | Its generic alias |
|---|---|
| TD-01 | `cad` |
| TD-02 | `inspection` |
| TD-04 | `gauge` |
| TD-06 | `assembly` |
| TD-07 | `welding` |

These are not two problems. They are one problem observed twice — a skill boundary nobody
has settled, and a bare token that papers over it. **Resolving the TD settles the alias; the
alias should not be resolved first.** That is why N5 (alias cleanup) sits *below* N2/N4 in
the graph and not above.

---

## 6. Cross-skill collision policy — `finishing`

**Not resolved here. Added to the human-review queue.**

Facts: `skill_deburring` (active, embedded) and `skill_furniture_finishing` (provisional,
unembedded) both carry the alias `finishing` in `en`. Legal under
`skill_alias_skill_norm_lang_uq` — the index is partitioned by `skill_id`. The hazard is L0:
an exact-equality probe on `finishing` matches two skills with nothing to rank them.

The four candidate readings, none selected:

1. **Legitimate ambiguous worker term** — a worker saying "finishing" genuinely could mean
   either; the correct response is a clarifying question, not a resolution.
2. **Alias should be removed from one skill** — most likely `skill_deburring`, where
   deburring is the specific act and "finishing" is the loose umbrella.
3. **Domain-scoped alias** — legitimate in both, disambiguated by `job_domain_id`, which the
   canonical retrieval path already scopes by. This is the only reading in which *both* keep
   it.
4. **Taxonomy problem** — the two skills overlap and the boundary itself is wrong.

*Evidence needed:* whether furniture finishing and metal deburring ever appear in the same
domain. If they never co-occur, reading 3 is safe and cheap. **This is a query I can run
without authorization and will run as part of PR-2.**

---

## 7. Alias lifecycle — made explicit

```
raw ──▶ normalized ──▶ candidate ──▶ reviewed ──▶ elected ──▶ searchable ──▶ embedded
```

The lifecycle is currently **partially representable**: the schema has `text_norm`,
`is_searchable`, `embedding`. It has **no column for `candidate` or `reviewed`**, which is
precisely why intent has to be carried in decision manifests rather than in the table.

Five non-implications, all now enforced in code:

| Not evidence of | Enforced by |
|---|---|
| `text_norm` ≠ approval | `hiddenByMissingNormalization` is a separate blocker from `hiddenWithoutDecision` |
| `is_searchable` ≠ intent | guard requires a named decision record |
| searchable sibling ≠ decision | removed in the third draft of the guard (§8, L-fixed) |
| election proposal ≠ applied election | replaying the manifest against today's state yields **96 contradictions**, not SAFE |
| embedding ≠ approval | `FULLY_EMBEDDED` is one of seven criteria, not a shortcut |

**Open design question for PR-1:** whether `candidate`/`reviewed` become a real column
(`skill_alias.review_status`) or stay in manifests. A column is queryable and survives a lost
file; a manifest is reviewable and cannot be silently UPDATEd. Recommendation: **column, plus
manifest** — the column is the state, the manifest is the evidence of the transition. This
needs a migration and is therefore additive-only (CLAUDE.md §10).

---

## 8. Promotion gates — exact current implementation and its loopholes

The seven criteria in `promote-skills.ts` are **not** the seven named in the request:

```ts
export const CRITERIA = [
  "GATE_ACCEPTED", "IS_PROVISIONAL", "ACTIVE_EDGE", "FULLY_EMBEDDED",
  "EVAL_COVERED", "RESOLVABLE_ABOVE_FLOOR", "NO_REGRESSION",
] as const;
```

| Requested | Reality |
|---|---|
| `EVAL_COVERED` | exists |
| `ABOVE_FLOOR` | **does not exist** — only `RESOLVABLE_ABOVE_FLOOR` |
| `RESOLVABLE_ABOVE_FLOOR` | exists — `best_correct_score >= 0.75` from a floor-sweep record |
| `NO_REGRESSION` | exists — `R@1 >= 1.0 && MRR >= 1.0`, no epsilon |
| `NO_COLLISION` | **does not exist** |
| `FRESH_EVALUATION` | **not a criterion** — implemented *inside* `NO_REGRESSION` |
| "Gate E" | not a code concept; `GATE_ACCEPTED` is the batch-acceptance criterion |

### Loopholes

| # | Loophole | Severity |
|---|---|---|
| **L1** | `corpusChangedAt = max(embedded_at)`. Blind to `text_norm`, `is_searchable`, taxonomy merges, edges, alias add/remove. **Election will not advance it**, so a pre-election evaluation passes the freshness check. | **Critical** |
| **L2** | Freshness lives inside `NO_REGRESSION`, so `--waive NO_REGRESSION` waives **both** the regression comparison and the staleness check in one flag. | **Critical** |
| **L3** | `EVAL_COVERED` accepts any case, including the 39 `corpus_alias` **mechanical** ones. A skill can be "covered" solely by an exact-match echo of its own alias — self-certifying. | High |
| **L4** | No collision gate. `skill_deburring` can be promoted while `finishing` is ambiguous. | High |
| **L5** | **No reachability gate.** `FULLY_EMBEDDED` checks embeddings; nothing checks `is_searchable`. Once the predicate ships, a skill can pass all seven criteria and be **live and unreachable** — the exact failure this whole workstream exists to prevent. | **Critical** |
| **L6** | `REGRESSION_BASELINE` is pinned to fixture v2. Fixture v3 makes `NO_REGRESSION` return *"cannot compare"* → permanent fail → pressure to waive. | High |
| **L7** | The floor-sweep artifact is read by path with **no freshness check at all** — same staleness class as L1, entirely unguarded. | High |
| **L8** | `ACTIVE_EDGE` is checked for promotion candidates, but 3 *already-active* skills have no edge. "Active" does not currently imply "reachable". | Medium |

**A skill must not be promotable merely because it has an embedding.** L5 is the gate that
makes that true, and it does not exist yet. It must land before N9, not after.

---

## 9. GP-04 — permanent regression test

| Measurement | Value |
|---|---|
| Failing query | `coolant level right on the turning machine` |
| Current resolution | `skill_turning` @ **0.7031** (wrong) |
| Canonical-label repair | `skill_coolant_management` @ **0.7509** |
| Margin over floor | **+0.0009** |
| Margin over `skill_turning` | +0.0477 |
| Recomputed under TD-03 | holds at 0.7509 (`skill_boring` scores 0.5307, rank 7) |

+0.0009 is **not** a safety margin — it is a rounding accident that happens to be on the
right side of the line. Treated as: *the repair is real, the margin is not evidence of
robustness.*

After every taxonomy / alias / embedding change, GP-04 must:
1. resolve to `skill_coolant_management`, **and**
2. score ≥ 0.75.

The separation margin is **recorded and trended, not thresholded**. No new numeric gate is
introduced without evidence for the number — inventing one would repeat exactly the mistake
`REGRESSION_BASELINE`'s own comment warns about.

---

## 10. Fixture strategy

Only `reviewed` participates in metrics. `mechanical` and `pending_review` are
coverage-only. That partition already exists in `partitionCases`.

Prioritisation for the 26 dark skills — **ordered by risk, not alphabetically**:

| Tier | Criterion | Skills |
|---|---|---|
| **1** | Carries or is shadowed by a generic alias | those in §5B |
| **2** | Involved in an open taxonomy merge | TD-01/02/04/06/07 members |
| **3** | Cross-domain ambiguity risk | `finishing` pair |
| **4** | No positive evidence of any kind | remainder of the 26 |
| **5** | Everything else | — |

**Not** mechanical exact-alias additions. The 52 empty paraphrase slots stay empty until a
trainer fills them; a query written by the same engineer who wrote the alias tests nothing.
This is the DC-18 lesson and it is not re-litigated.

---

## 11. Evaluation ladder

Every rung is a separate immutable record. No rung overwrites another.

| Rung | Measures | Prerequisite |
|---|---|---|
| **E0** | `EXP-P8-BASELINE` — R@1 0.9912, MRR 0.9956 | ✅ exists, immutable |
| **E1** | taxonomy merges only, no alias changes | N4 |
| **E2** | alias additions/removals, independently | N5 |
| **E3** | election + retrieval predicate | N7, N9 |
| **E4** | canonical labels | N10 |
| **E5** | fixture v3 coverage | N8 |
| **E6** | final promotion evaluation, after `max(embedded_at)` | all |

### Record schema — v3 (required extension)

Present today: `experiment`, `run_id`, `recorded_at`, `evaluator_version`,
`fixture_version`, `fixture_id`, `corpus_batch`, `embedding_model`, `model`, `ann`,
`recall_at_1/3/5`, `mrr`, `query_count`, `failure_count`, `latency_ms`, `input_tokens`,
`cost_inr_estimated`, `cost_inr_metered`, `purpose`, `notes`, `detail`.

**Missing and required:** `corpus_hash`, `alias_count`, `searchable_count`,
`taxonomy_version`, `empty_count`, `outrank_count`, `structural_checks`, `coverage`.

`corpus_hash` and `searchable_count` also give L1 a real freshness signal. **Extending this
schema is PR-1**, and it is a prerequisite for every rung including E1.

---

## 12. Provider quota

Both embedders batch **100 rows per provider request** (`EMBED_BATCH_SIZE`, capped 200), and
`db:embed:skills --plan` produces a call/token plan **without calling anything**.

| Job | Texts | Requests @100 | Authorized? |
|---|---:|---:|---|
| 33 unembedded provisional aliases | 33 | 1 | No |
| 84 canonical labels (OK set) | 84 | 1 | No |
| `job_domain_alias` corpus | 9,121 | ~92 | No |
| Re-embed after a taxonomy merge | varies | varies | No |

The trap already hit once: `POST /embeddings/skill-alias` sends **one text per request**, so
an ad-hoc 232-text experiment costs 232 requests while the batched corpus embedder costs ~2.
**Never run experiments through the per-text path.**

Rule: **no embedding of an alias whose skill is subject to an unresolved taxonomy decision.**
Embedding `skill_boring`'s aliases before TD-03 executes spends quota on a vector that a
merge invalidates.

---

## 13. Canonicalization

`skill_canonicalize_enabled = false` and stays false until **all nine** hold: taxonomy
stable · aliases reviewed · election verified · predicate verified · fresh evaluation exists
· NO_REGRESSION passes · floor passes · coverage acceptable · promotion gates pass.

Its enablement is a **standalone PR** containing the flag flip and nothing else.

---

## 14. Domain generation — correctly scoped

Not "generate 4,071 domains". They exist. The real work:

- **4,043** domains have no skill edge.
- **9,121** domain aliases have no `text_norm`, no embedding, no searchable flag.

Required before it is even considered: exact domain count · affected rows · runtime estimate
· provider call count (~92 for aliases alone) · expected DB writes · rollback · sampling
strategy · dry-run output · validation criteria · incremental rollout.

**Pilot first**: one NCO major group, measured end-to-end, before anything wider.

---

## 15. Execution DAG — PR sequence

| # | Node | Kind | Auth | Prereq |
|---|---|---|---|---|
| **PR-1** | Gate repair: real freshness signal, split `FRESH_EVALUATION` from `NO_REGRESSION`, add `NO_COLLISION` + `RETRIEVABLE`, `EVAL_COVERED` counts only `reviewed`, sweep freshness, eval-record schema v3 | code | merge | — |
| **PR-2** | Read-only: domain-side state report; `finishing` co-occurrence query; generic-alias risk register committed | docs | merge | — |
| **PR-3** | Domain-alias normalizer (mirrors the skill one) | code | merge | PR-2 |
| **WRITE-1** | `job_domain_alias` normalize + elect | **DB write** | **you** | PR-3 |
| **EMBED-1** | Domain-alias corpus, ~92 requests | **provider** | **you** | WRITE-1 |
| — | *TD-04 / TD-06 / TD-07 / TD-01 terms* | decision | **trainer + product** | **BLOCKED** |
| **ISSUE** | AI #935 → Mobile #936 | cross-team | AI + Mobile owners | TD resolution |
| **PR-4** | Backend taxonomy merges (TD-01/02/03) | code + data | **you** | #935 + #936 merged |
| **EVAL-E1** | taxonomy-only | eval | auto | PR-4 |
| **PR-5** | Alias cleanup + generic-alias demotions | data | **you** | TD-04/06/07 |
| **EVAL-E2** | alias-only | eval | auto | PR-5 |
| **WRITE-2** | Election apply | **DB write** | **you** | PR-1, PR-5 |
| **PR-6** | Retrieval predicate (separate PR — election must stay attributable) | code | **you** | WRITE-2 verified |
| **EVAL-E3** | election + predicate | eval | auto | PR-6 |
| **PR-7** | Fixture v3 + trainer-reviewed cases | data | **trainer** | §10 |
| **PR-8** | Canonical labels, re-measured post-merge | data | **you** | EVAL-E2 |
| **EMBED-2** | Canonical labels + 33 backlog | **provider** | **you** | PR-8 |
| **EVAL-E4/E5** | labels, coverage | eval | auto | EMBED-2 |
| **PR-9** | Re-baseline `REGRESSION_BASELINE` to fixture v3 | code | **you** | EVAL-E5 |
| **EVAL-E6** | final | eval | auto | PR-9 |
| **PR-10** | Promotion | **DB write** | **you** | all gates |
| **PR-11** | Canonicalization flag, alone | config | **you** | PR-10 |
| **PILOT** | One NCO major group | **DB + provider** | **you** | PR-11 |

---

## 16. Authorization matrix

| Class | Examples | Who |
|---|---|---|
| **Autonomous** | reads, dry runs, `--rollback` rehearsals, manifests, tests, docs, PRs, offline sims, GP-04 re-measurement, static analysis | me |
| **Your authorization** | any DB write, provider run, predicate change, promotion, canonicalization, domain generation | you |
| **RVM trainer** | TD-04, TD-06, TD-07, TD-01 terms, `drawing padhna` form, 16 draft-reviewed skills, 52 paraphrase slots, 35 REVIEW labels, `finishing` | trainer |
| **AI owner** | #935 — `signals.py`, `canonicalization_gold.py`, `miss_attribution.py`, `lexicon_data/skills.json` | AI |
| **Mobile owner** | #936 — `taxonomy_labels.dart` | Mobile |
| **Product** | TD-07 policy | product |
| **Quota-gated** | EMBED-1, EMBED-2, PILOT | quota + you |

---

## 17. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | **Stale-evidence loophole (L1/L2)** — election doesn't move `max(embedded_at)`, so post-election gates read pre-election evidence | **High** | **Critical** | PR-1 before any further mutation |
| **R2** | **Active-skill unreachability (L5)** — predicate ships, no gate checks searchable | Medium | **Critical** | `RETRIEVABLE` gate in PR-1; predicate PR-6 only after WRITE-2 verified |
| **R3** | **Domain side dead** — 0 searchable domain aliases against a partial index | **Measured locally** | **Critical** | Verify production first (PR-2), then PR-3/WRITE-1 |
| **R4** | Generic aliases shadow whole families (`fitting` → 4) | **Certain** | High | §5; resolve TD first, alias second |
| **R5** | GP-04 margin +0.0009 | High | High | Re-measure at every rung; trend the margin |
| **R6** | AI/Mobile dangling IDs | Medium | High | #935/#936 merge first; never bypass |
| **R7** | Fixture contamination — mechanical cases satisfying `EVAL_COVERED` | **Certain today** | High | L3 fix in PR-1 |
| **R8** | Fixture v3 breaks NO_REGRESSION (L6) | **Certain** | Medium | PR-9 re-baseline as an explicit reviewed act |
| **R9** | Quota spent on soon-invalid vectors | Medium | Medium | No embedding under an unresolved TD; `--plan` first |
| **R10** | Evidence overwrite | **Happened once** | High | `writeArtifact()` refuses; recovered from git |
| **R11** | Accidental irreversible write | Low | **Critical** | Dry-run default, manifest+sha256, four in-transaction guards |
| **R12** | Invisible control characters | **Happened twice** | Medium | Repo-wide scan in CI-adjacent test |
| **R13** | Cross-skill collision promoted (L4) | Medium | Medium | `NO_COLLISION` in PR-1 |
| **R14** | Silent taxonomy invention | Low | **Critical** | Everything unevidenced recorded BLOCKED |

---

## 18. Stop conditions

I stop and ask before:

1. any `INSERT`/`UPDATE`/`DELETE` on a live table — with manifest + sha256 + rollback;
2. any provider-consuming run — with exact call count, token estimate, quota check;
3. any backend taxonomy merge — only once #935 and #936 are merged and verified;
4. any change to production retrieval semantics;
5. enabling canonicalization;
6. any domain-scale generation.

I stop and record **BLOCKED** (no assumption) when:

7. a taxonomy decision lacks trainer/product evidence — TD-04, TD-06, TD-07, TD-01 terms;
8. ground truth would have to be authored by engineering;
9. a threshold would have to be invented without evidence.

I proceed **without asking** on: reads, dry runs, rollback rehearsals, manifests, tests,
static analysis, docs, PRs (merge still yours), offline simulation, GP-04 re-measurement.

After every authorized mutation: **apply → independently verify → immutable evidence → stop.**
Never mutation + evaluation + promotion in one operation.

---

## 19. Immediate next actions (all autonomous)

1. **PR-1** — gate repair. It is the prerequisite for trusting everything downstream, and
   R1/R2/R7 all close with it.
2. **PR-2** — read-only: verify production domain-side state, run the `finishing`
   co-occurrence query, commit the generic-alias risk register.

Neither mutates anything. The election stays PROPOSED until PR-1 lands and TD-04/06/07 are
answered — it is *not* the next action, and treating it as one is what this plan replaces.

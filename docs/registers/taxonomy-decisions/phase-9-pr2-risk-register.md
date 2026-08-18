# PR-2 — Domain-side & production investigation, and the risk register

> **Read-only.** Every figure below was obtained with `SELECT`. Nothing was written, no
> provider was called, no index was rebuilt. Measured **2026-08-18**.

---

## 0. The headline: production and the dev corpus are different systems

The Phase 5–9 workstream has been measuring a corpus that **production does not have**.

| | local dev (docker) | **production** (Supabase pooler) |
|---|---:|---:|
| `skill` | 146 — 33 active, 113 provisional | **51 — all active** |
| `skill_alias` | 328 | **98** |
| ├ `text_norm` | 328 | **0** |
| ├ `is_searchable` | 197 | **0** |
| ├ embedded | 295 | 76 |
| └ `embedding_model` | `gemini-embedding-001` | **NULL on all 98** |
| `job_domain` | 4,071 | 4,071 |
| `job_domain_skill` edges | 238, over 28 domains | **0, over 0 domains** |
| `job_domain_alias` | 9,121 | 9,121 |
| ├ `text_norm` | **0** | **9,121** |
| ├ `is_searchable` | **0** | **5,086** (3,515 domains reachable) |
| └ embedded | **0** | **9,121** |
| migrations applied | — | 76 (so 0076 *is* live) |

Production skill sources: `rvm` 27, `onet` 12, `esco` 9, `nco` 3. Of five taxonomy skill ids
probed, four exist (`skill_turning`, `skill_bench_fitting`, `skill_deburring`,
`skill_gdt_reading`) and **`skill_coolant_management` does not** — the skill GP-04's entire
repair depends on.

### Two corrections to the Phase 9 master plan

**⚠B was wrong about production, and is withdrawn.** I reported the domain side as possibly
dead based on the local corpus. In production it is the *healthy* half: 9,121 aliases
normalized and embedded, 5,086 searchable, 3,515 domains reachable through the partial HNSW
index. The empty domain surface is a **local dev gap** — nobody ran `db:normalize:aliases`
or `db:embed:domains` against docker. It was flagged as unverified; the verification says no.

**It is replaced by something worse.** Production has **zero `job_domain_skill` edges**, so
`canonicalAliasRows` — the Gate-A-protected canonical path — can return nothing at all
there. Every skill resolution in production runs through `legacyAliasRows` and its
`sa.domain_id` filter (98 aliases, 10 slugs, all populated). The path Phases 5–9 have been
optimising is not the path production is using.

---

## 1. `finishing` co-occurrence — investigated, still not resolved

| Query | Result |
|---|---|
| `skill_deburring` active domains | **3** — `jd_isco_7213`, `jd_nco_7223_0701`, `jd_nco_7223_2400` |
| `skill_furniture_finishing` active domains | **0** |
| Shared domains | **0** |

**The collision is latent, not active.** Canonical retrieval scopes by `job_domain_id`, and
`skill_furniture_finishing` has no edge in any domain — so today nothing can reach it
through that path, and `finishing` resolves unambiguously to `skill_deburring`.

That safety is **accidental, not decided**. It rests on an absent edge, and the first edge
that lands in any of deburring's three domains makes the ambiguity live with no warning.

This narrows the four readings from the master plan but does not settle them, and the
decision stays with the trainer:

- **Reading 3 (domain-scoped alias)** is now the cheapest and is currently satisfied by
  construction — but only while `furniture_finishing` stays edgeless.
- **Readings 1, 2 and 4** are untouched by this evidence.

**Recorded as PENDING_HUMAN_REVIEW.** No alias was removed, no skill merged.

---

## 2. Risk register

| # | Finding | Sev | Affected tables / code paths | Evidence | Current impact | Required remediation | Phase / dependency | Mutation? |
|---|---|---|---|---|---|---|---|---|
| **R1** | Freshness signal was `max(embedded_at)` — blind to `text_norm`, `is_searchable`, alias add/remove, skill status, edges, domain aliases | **Critical** | `promote-skills.ts` `judgeRegression` | Code read; election moves none of those timestamps | A post-election gate would read pre-election evidence as current | Corpus fingerprint over 5 components | **PR-1 — fixed** | No |
| **R2** | `--waive NO_REGRESSION` also waived the staleness check | **Critical** | `promote-skills.ts` `judge` | Single criterion carried both | One flag granted two unrelated permissions | `stale` flag, non-waivable | **PR-1 — fixed** | No |
| **R3** | No gate checked retrievability; `FULLY_EMBEDDED` only checked vectors | **Critical** | `promote-skills.ts`, `skills.repository.ts` | Gate audit | Once the predicate ships, a skill passes all 7 criteria while unreachable | 4th condition on `FULLY_EMBEDDED`, pinned to production SQL | **PR-1 — fixed** | No |
| **R4** | `EVAL_COVERED` counted 39 mechanical `corpus_alias` cases | High | `promote-skills.ts`, `retrieval-v2.jsonl` | 127 cases = 88 reviewed + 39 mechanical | A skill could be "measured" by an echo of its own alias | Count only `isScoreable` cases | **PR-1 — fixed** | No |
| **R5** | Floor-sweep artifact read by path with no freshness check at all | High | `promote-skills.ts` `RESOLVABLE_ABOVE_FLOOR` | Code read | A pre-alias-change sweep clears a post-change corpus | Fingerprint-check the sweep; unwaivable | **PR-1 — fixed** | No |
| **R6** | **Taxonomy corpus is not deployed.** Production has 51 skills / 98 aliases; dev has 146 / 328 | **Critical** | `skill`, `skill_alias`, `job_domain_skill` | This document, §0 | Every Phase 5–9 measurement describes a corpus production does not have. `skill_coolant_management` — GP-04's repair — is absent | A deployment plan for the taxonomy corpus, sequenced and authorized separately | **NEW — blocks promotion having meaning** | **Yes, later** |
| **R7** | **Production has 0 `job_domain_skill` edges** — canonical path returns nothing | **Critical** | `canonicalAliasRows`, `job_domain_skill` | 0 edges, 0 domains | Production resolves skills only via the legacy `sa.domain_id` path. Phases 5–9 optimised the canonical path | Decide: deploy edges, or treat legacy as the production path and evaluate it | **NEW — blocks the predicate** | **Yes, later** |
| **R8** | Production `skill_alias.embedding_model` is NULL on all 98 | High | `skill_alias` | Probe | No provenance: a mock vector is indistinguishable from a real one; `FULLY_EMBEDDED` cannot verify model coherence | Re-embed with provenance, or record the 98 as legacy-unattributable | R6 | **Yes, later** |
| **R9** | Production `skill_alias` has 0 `text_norm` / 0 `is_searchable` | High | `skill_alias` | Probe | The Phase 8 normalization was applied to **dev only**. L0 unavailable in production | Run the normalizer against production, under the same manifest discipline | After R6 | **Yes, later** |
| **R10** | Local dev has 0 normalized / 0 embedded / 0 searchable domain aliases against a **partial** HNSW index | Medium | `job_domain_alias`, `nearestDomains` | Probe; index is `WHERE is_searchable` | Domain resolution is dead **locally**, so local end-to-end evaluation of the full chain is not possible | Run `db:normalize:aliases` + `db:embed:domains` against docker | Dev-env task | Dev only |
| **R11** | `fitting` shadows 4 skills; `welding` 3; `inspection`/`assembly` 2 each | High | `skill_alias` | Generic-alias report | Bare tokens win matches meant for specific skills | Resolve the owning TD first, then the alias | After TD-01/02/04/06/07 | **Yes, later** |
| **R12** | `finishing` cross-skill collision | Medium | `skill_alias` | §1 | **Latent** — 0 shared domains, and `furniture_finishing` has no edges | Trainer decision; re-check if it gains an edge | Human review | No (yet) |
| **R13** | 3 active skills have no active edge (`welder_`/`fitter_`/`machinist_occupation`) | Medium | `skill`, `job_domain_skill` | Local probe | "Active" does not imply "reachable"; TD-07 option 1 is unavailable | Decide whether occupation-level skills should be edged or retired | TD-07 | **Yes, later** |
| **R14** | GP-04 margin is **+0.0009** over the floor | High | eval fixture | `EXP-P8-BASELINE` | A rounding accident on the right side of the line | Re-measure at every rung; trend the margin, never threshold it | Every eval | No |
| **R15** | Fixture v3 makes `NO_REGRESSION` structurally unpassable | High | `promote-skills.ts` `REGRESSION_BASELINE` | `judgeRegression` refuses cross-version comparison | Pressure to waive the gate | Re-baseline as an explicit reviewed act | Distinct phase before promotion | No |
| **R16** | Evidence overwrite | High | evidence artifacts | Happened once, recovered from git | An immutable record silently replaced | `writeArtifact()` refuses to overwrite | Fixed | No |
| **R17** | Invisible control characters in SQL templates | Medium | `packages/db/src` | Happened twice (NUL, U+0001) | Digest mismatches that look like corruption | Repo-wide scan test; explicit `chr(1)` | Fixed | No |
| **R18** | Quota spent on vectors a later taxonomy decision invalidates | Medium | provider | — | Wasted daily quota | No embedding under an unresolved TD; `--plan` first | Every embed | No |

---

## 3. Corrected dependency DAG

```
        ┌──────────────────────────────────────────────────────────────┐
   ✅   │ PR-1  gate repair — fingerprint, unwaivable staleness,       │
        │       reachability invariant, reviewed-only EVAL_COVERED     │
        └───────────────────────────┬──────────────────────────────────┘
                                    ↓
        ┌──────────────────────────────────────────────────────────────┐
   ✅   │ PR-2  production verification (this document)                │
        └───────────────────────────┬──────────────────────────────────┘
                                    ↓
        ┌──────────────────────────────────────────────────────────────┐
   NEW  │ D0  DEPLOYMENT DECISION  (R6/R7)                             │
        │     Which corpus is production going to run?                 │
        │     Nothing downstream has production meaning until this is  │
        │     answered — it is a decision, not a task.                 │
        └───────────────────────────┬──────────────────────────────────┘
                                    ↓
   TD-04 / TD-06 / TD-07 / TD-01 terms ──── BLOCKED on trainer + product
                                    ↓
   AI #935  ──▶  Mobile #936  ──▶  Backend taxonomy merges (TD-01/02/03)
                                    ↓
                                  EVAL-E1  (taxonomy only)
                                    ↓
   alias cleanup + generic-alias demotions (R11, R12, R13)
                                    ↓
                                  EVAL-E2  (alias only)
                                    ↓
   skill_alias election  ──▶  independent verification  ──▶  STOP
                                    ↓
   retrieval predicate  (separate PR; election must stay attributable)
                                    ↓
                                  EVAL-E3
                                    ↓
   fixture v3 (trainer)  ──▶  canonical labels  ──▶  embedding
                                    ↓
                              EVAL-E4 / E5
                                    ↓
   RE-BASELINE  (explicit, reviewed, never mixed into an evaluation)
                                    ↓
                                  EVAL-E6
                                    ↓
   promotion  ──▶  canonicalization (alone)  ──▶  domain pilot
```

### The enforcement properties this graph guarantees

1. **AI/Mobile land before Backend.** #935 → #936 → merges. No stable `main` ever references
   a dissolved skill id from another team's surface.
2. **Taxonomy precedes alias cleanup**, because every open TD has a generic alias sitting on
   top of it — resolving the alias first would be settling the TD by side effect.
3. **Domain resolution is upstream of skill retrieval** — and in production it is the half
   that already works; the missing half is the skill edges (R7).
4. **Gate repair precedes any evidence we intend to trust** — PR-1 is done, so everything
   measured from here carries a fingerprint.
5. **Fixture expansion cannot orphan `NO_REGRESSION`**: re-baselining is its own node,
   after E5 and before E6, and never inside an evaluation.
6. **The 4,071 domains are not created** — they exist. The work is 4,043 missing skill-edge
   sets, and in production *all* of them are missing.
7. **Canonicalization stays OFF** until every gate above passes.

---

## 4. What changed in my own conclusions

| Earlier claim | Status |
|---|---|
| "Domain side may be dead" (⚠B) | **Withdrawn.** True locally, false in production — the domain surface is production's healthy half |
| "The election is the next mutation" | **Still wrong, and now for a second reason** — R6/R7 mean it would be applied to a corpus production does not run |
| "4,071-domain generation is mis-scoped" | **Confirmed and sharpened** — 4,043 domains lack edges locally; *all* 4,071 lack them in production |
| GP-04 repair depends on `skill_coolant_management` | **Newly load-bearing** — that skill does not exist in production |

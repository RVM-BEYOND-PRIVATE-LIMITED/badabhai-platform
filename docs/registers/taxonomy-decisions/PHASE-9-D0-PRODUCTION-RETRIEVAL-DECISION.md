# PHASE-9-D0 — Production retrieval contract: decision brief

> **Read-only investigation.** No mutation, no provider call, no flag change.
> Code read at `origin/main`; production figures obtained with `SELECT` on 2026-08-18.
> Prior results: [PR-1 gate repair](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/953) ·
> [PR-2 investigation](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/954) ·
> [risk register](./phase-9-pr2-risk-register.md) · [master plan](./phase-9-master-plan.md)

> ### ⚠ CORRECTION 2026-08-18 — taxonomy decision state (affects §5 stage B, §6, §8)
>
> Authored while TD-01/02/03/04/06 were open; merged after they had been ratified and applied.
> **TD-01, TD-02, TD-03, TD-04 and TD-06 are RATIFIED AND APPLIED** by owner-direct
> ratification (Prakash, Backend Platform owner / TL), superseding the trade-trainer artifact
> requirement for those five — the artifacts were never independently supplied. **TD-05 stays
> deferred (keep split); TD-07 remains an unresolved gap.** Authoritative statement:
> [`phase-9-master-plan.md` §0.1](./phase-9-master-plan.md#01-authoritative-phase-8-decision-state-correction-2026-08-18).
>
> **The D0 recommendation itself is unchanged.** Path A remains the target and production
> still runs Path B. What changed is that Stage B's gate ("taxonomy decisions settled") is now
> *partly* satisfied, and that the settled decisions introduced a new Path-A-specific defect —
> `skill_drawing_reading` has **zero `job_domain_skill` edges** — which must be characterized
> before Stage B, not after. **The TD-01 edge re-point is NOT authorized.**

---

## 1. D0 decision

**Recommendation: adopt Path A (`job_domain_skill`) as the target production contract, and
do not migrate production — because there is nothing live to migrate.**

The single most important finding of this investigation reframes the whole question:

> **Skill canonicalization is not running in production.** Both live callers hard-code the
> legacy slug `cnc-machining`, nothing writes `job_postings.job_domain_id` (8 postings, 0
> set), `job_domain_skill` is empty, and `skill_canonicalize_enabled` defaults to `false`.

This is **not a migration between two working systems**. It is a **first activation**, and
choosing Path A now costs nothing in production behaviour because Path B is not producing
production behaviour either. The risk posture is far better than the framing "move
production to the newer path" implies.

**Two things must be confirmed by a human before this decision is final** — I cannot read
production environment variables:

- **D0-Q1** — the deployed value of `SKILL_CANONICALIZE_ENABLED` (default `false`;
  `.env.example` `false`).
- **D0-Q2** — the deployed value of `DOMAIN_MATCH_ENABLED` (default `false`), which matters
  because production *does* have 5,086 searchable domain aliases and 2 `worker_profiles`
  rows with `job_domain_id` set. Either it is on, or something else wrote that column.

If D0-Q1 is `true`, the recommendation is unchanged but the migration becomes a genuine
cutover with a live baseline, and Phase C (shadow) becomes mandatory rather than advisory.

---

## 2. The two paths, as production actually executes them

### 2.1 Live call graph — what runs today

```
WORKER PROFILING                                JOB POSTINGS
POST /profile/extract                           POST/PATCH job posting
  │                                               │
  ├─ domain_match.match_domain()                  │
  │    ├─ pinned_job_domain_id ──────┐            │
  │    └─ store.nearest_domains()    │            │
  │         POST /internal/skills/   │            │
  │              nearest-domains     │            │
  │         → job_domain_alias ANN   │            │
  │           (PARTIAL HNSW,         │            │
  │            WHERE is_searchable)  │            │
  │                                  ↓            │
  │                          DomainMatch.job_domain_id  ── jd_* id produced
  │                                  │
  │                                  └──▶ REPORTED on the response only
  │                                       (profile.py:422, JobDomainMatch)
  │                                       ✗ NOT used to scope canonicalization
  │
  └─ canonicalize_labels(labels,                  └─ scope = jobDomainId != null
        settings.skill_canonicalize_default_domain     ? {job_domain_id}      ← never
        = "cnc-machining")            ← ALWAYS      : {domain_id: "cnc-machining"} ← always
                  │                                            │
                  └──────────────┬─────────────────────────────┘
                                 ↓
                    POST /internal/skills/nearest-aliases
                                 ↓
                    SkillsRepository.nearestAliases(scope)
                                 ↓
                 scope.kind === "canonical" ?  ✗ never reached in production
                       canonicalAliasRows      ←── PATH A
                                 :
                       legacyAliasRows         ←── PATH B  ✓ the only live path
```

**The `jd_*` id is computed and then discarded for retrieval purposes.** Domain match
produces it, the response reports it, and the canonicalization fan-out immediately scopes by
a hard-coded slug instead. That is the crux of the divergence.

### 2.2 Path A — canonical (`job_domain_skill`)

| | |
|---|---|
| Entry | `POST /internal/skills/nearest-aliases` with `job_domain_id` |
| Code | `skills.dto.ts:toAliasSearchScope` → `SkillsRepository.canonicalAliasRows` |
| Tables | `skill_alias`, `job_domain_skill`, `skill` |
| Reachable in production | **No.** Only `/skills/canonicalize` forwards `job_domain_id`, and its only caller (job-postings) never sets it |
| Production rows available | `job_domain_skill` = **0** |

```sql
SELECT sa.skill_id, 1 - (sa.embedding <=> $1::vector) AS score
FROM skill_alias sa
JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
JOIN skill s ON s.skill_id = sa.skill_id
WHERE jds.job_domain_id = $2
  AND jds.status = 'active'
  AND s.status = 'active'
  AND sa.embedding IS NOT NULL
ORDER BY sa.embedding <=> $1::vector
LIMIT $3
```

### 2.3 Path B — legacy (`skill_alias.domain_id`)

| | |
|---|---|
| Entry | same route, with `domain_id` |
| Code | `SkillsRepository.legacyAliasRows` |
| Tables | `skill_alias`, `skill` |
| Reachable in production | **Yes — the only live path** |
| Scoping value | hard-coded `"cnc-machining"` at *both* call sites (`config.py:381`, `job-postings.service.ts:45`) |

```sql
SELECT sa.skill_id, 1 - (sa.embedding <=> $1::vector) AS score
FROM skill_alias sa
JOIN skill s ON s.skill_id = sa.skill_id
WHERE sa.domain_id = $2
  AND s.status = 'active'
  AND sa.embedding IS NOT NULL
ORDER BY sa.embedding <=> $1::vector
LIMIT $3
```

### 2.4 Point-by-point comparison

| Question | Path A | Path B |
|---|---|---|
| Worker's domain selected by | `nearest_domains` ANN over `job_domain_alias`, or an interview pin | **not selected** — a constant |
| Skills become reachable via | an `active` `job_domain_skill` edge | a matching `skill_alias.domain_id` slug |
| Ranking differs? | **No.** Identical `ORDER BY sa.embedding <=> $1 LIMIT k`. Only the candidate SET differs | same |
| Embeddings involved? | Yes — `skill_alias.embedding`, both paths | Yes |
| Used by the live flow? | **No** | **Yes** |
| Used by canonicalization? | code path exists, never invoked | yes, when the flag is on |
| Domain granularity | 4,071 `jd_*` domains | **10** hand-minted slugs |
| Effective production universe | 0 aliases | **22 embedded aliases / 10 skills** |

**Path B's ceiling is the finding that decides this.** Production holds 98 aliases across 10
slugs, but because both callers pass `cnc-machining`, the live system can only ever return
one of **10 skills** from **22 embedded aliases**. Everything else in the catalogue is
unreachable by construction, not by ranking.

---

## 3. Parity matrix

Each row classified, not merely counted.

| Surface | Local | Production | Classification | Required for parity |
|---|---:|---:|---|---|
| `skill` | 146 (33 active, 113 prov.) | 51 (all active) | **Stale deployment** — the taxonomy bootstrap never shipped | Deploy the corpus, or accept two catalogues |
| `skill_alias` | 328 | 98 | Stale deployment | Deploy |
| normalized (`text_norm`) | 328 | **0** | **Missing backfill** — 0076 is applied (76 migrations), the runner never ran there | Run the normalizer against production |
| searchable | 197 | **0** | Missing backfill — downstream of normalization | Election, after normalization |
| skill embeddings | 295 (`gemini-embedding-001`) | 76 (**model NULL**) | **Schema evolution** — 0076 added provenance and states the pre-existing vectors cannot be attributed retroactively | Re-embed, or formally record the 76 as legacy-unattributable |
| `job_domain` | 4,071 | 4,071 | **Intentional — parity already holds** | none |
| domain aliases | 9,121 | 9,121 | **Intentional — parity holds** | none |
| domain normalized | **0** | 9,121 | **Local fixture gap** — docker never ran `db:normalize:aliases` | Local-only dev task |
| domain searchable | **0** | 5,086 | Local fixture gap | Local-only dev task |
| domain embeddings | **0** | 9,121 | Local fixture gap | Local-only dev task |
| `job_domain_skill` edges | 238 / 28 domains | **0 / 0** | **Architectural incompatibility** — Path A cannot function without these | Generate + deploy edges |
| Path B active? | yes (10 slugs) | **yes (1 slug used)** | Intentional legacy design | — |
| Path A active? | possible (238 edges) | **no** | Architectural gap | Edges + caller change |
| `job_postings.job_domain_id` | — | 8 rows, **0 set** | **Missing migration/backfill** — column exists, nothing writes it | A writer, or retire the branch |

**The two environments are not "the same system at different versions".** Production is
strong exactly where local is empty (the domain surface) and empty exactly where local is
strong (the skill surface). Neither is a subset of the other.

### Why the divergence exists

1. The domain catalogue (0066/0067) **was** deployed and backfilled — production ran
   `db:normalize:aliases` and `db:embed:domains` for `job_domain_alias`. Local never did.
2. The Phase 3–8 taxonomy bootstrap (146 skills, 328 aliases, 238 edges) has **only ever
   existed in dev**. It was authored, gated, embedded and evaluated locally, and no
   deployment step was ever part of the phase plan.
3. `skill_alias.domain_id` predates the `jd_*` catalogue. Migration 0076 made it nullable
   legacy metadata and added the canonical path, but deliberately did **not** re-domain the
   98 shipped aliases — SG-5 defines re-domaining as deprecate-and-recreate.

None of this is a fault. It is the expected state of a two-track migration that completed
track one (domains) and has not started track two (skills).

---

## 4. Recommended target architecture

**Path A**, for four reasons that are properties of the data, not preferences:

1. **Path B cannot express the taxonomy.** 10 slugs cannot scope 4,071 domains. Every skill
   minted by the bootstrap carries a NULL `skill_alias.domain_id` and is structurally
   invisible to Path B — that is what `canonicalAliasRows` was built for.
2. **The upstream half of Path A is already live and healthy in production.**
   `nearest_domains` returns `jd_*` ids from 5,086 searchable aliases over 3,515 reachable
   domains. Production already computes the scope Path A needs, then throws it away.
3. **Ranking is identical.** Both paths run the same distance expression, order and limit.
   Switching changes the candidate *set*, never the scoring — so a parity comparison is
   meaningful and a regression is attributable.
4. **Nothing is live to break.** Canonicalization appears to be off, and even if on, its
   reach is 10 skills.

**Supporting both paths permanently is the option to reject.** The risks are concrete: two
candidate sets with no defined precedence; a skill reachable through one and not the other;
`unresolved_phrase` unable to record a canonical-scoped miss (the DTO requires a non-null
`domain_id`, documented at `skills.dto.ts`); and two retrieval semantics for the promotion
gate to pin, when PR-1 assumes one. Dual paths are acceptable **only** as the Phase C shadow
window, with an explicit end date.

---

## 5. Staged migration plan

Every stage lists its own gate. No stage begins until the previous one's "must be true"
holds.

| Stage | Mutations | Expected rows | Invariants | Comparison metric | Rollback | Must be true first |
|---|---|---|---|---|---|---|
| **A — Observe** | none | — | Path B remains the only live path | Baseline: Path B recall over its 22-alias universe; volume of canonicalization calls | n/a | D0-Q1/Q2 answered |
| **B — Backfill** | deploy taxonomy corpus to production: `skill`, `skill_alias`, `job_domain_skill`; then normalize + elect | +95 skills, +230 aliases, +238 edges | Additive only. No existing row's `domain_id`, `embedding` or `status` changes. Path B's 22-alias universe is **bit-identical** afterwards | Path B result set before vs after must be **unchanged** | Delete the added rows by id set; edges are the only new table content | ~~Taxonomy decisions settled (TD-01…07)~~ → **CORRECTED:** TD-01/02/03/04/06 settled ✅, TD-05 deferred, **TD-07 still open**; gate repair merged ✅ #953; **plus R19 — the `skill_drawing_reading` zero-edge condition — measured by the offline replay and explicitly decided.** Stage B must not import an unmeasured Path-A defect |
| **C — Dual-read / shadow** | none | — | Path A computed and logged, Path B still authoritative | Per-request: top-1 agreement, score delta, Path A empty-rate | Disable the shadow flag | Phase B verified |
| **D — Parity verification** | none | — | — | Agreement ≥ an agreed threshold **derived from the shadow data**, not invented in advance; every disagreement classified | n/a | ≥ N shadow requests, N agreed with you |
| **E — Read switch** | caller change: pass `job_domain_id` where domain match produced one | — | Fall back to Path B when domain match yields nothing | Same metrics, now on the live path | Revert the caller change (config/deploy, no DB) | Phase D passed |
| **F — Rollback window** | none | — | Both paths healthy, Path A authoritative | Watch for recall cliffs and `unresolved_phrase` volume | Flip back to Path B | Phase E stable |
| **G — Legacy retirement** | drop the legacy branch; possibly retire `skill_alias.domain_id` reads | — | No caller sends `domain_id` | — | Restore the branch | Window elapsed with no rollback |

**Phase B is the one irreversible-ish stage** and it is deliberately *additive*: nothing
existing is mutated, so rollback is a delete over a captured id set — the same discipline
the `text_norm` write used.

**Shadow-read strategy (Phase C):** run `canonicalAliasRows` alongside `legacyAliasRows` in
`nearestAliases`, return Path B, log both. This requires the API change to be behind a flag
and adds one query per canonicalization call. It is the only way to get a parity number
against real traffic rather than a fixture.

---

## 6. Implications

### Gates (PR-1 already anticipated this)

`PRODUCTION_RETRIEVAL_SEMANTICS` currently describes Path A's predicates
(`requiresActiveEdge: true`). That is correct for the *target* and **wrong for what
production runs today**, where there is no edge requirement. It needs a
`RETRIEVAL_PATH` dimension before it can describe both. Straightforward, and PR-1's pin
already makes the drift visible.

`ACTIVE_EDGE` as a promotion criterion is meaningless for Path B — production has zero
edges, so under Path B no skill would ever pass it. Another reason the target must be
settled before promotion runs.

### Evaluation

`CANONICAL_RETRIEVAL_SQL` implements **Path A**. So the entire Phase 5–8 evaluation
programme measured the path production does not execute. That is not wasted work — it is
exactly the right measurement for the recommended target — but it must never be quoted as
production performance.

**Every future experiment record must carry:**

```
CORPUS_ENVIRONMENT   local | staging | production
RETRIEVAL_PATH       legacy | job_domain_skill
CORPUS_VERSION       taxonomy corpus batch id
CORPUS_FINGERPRINT   (PR-1)
RETRIEVAL_SEMANTICS  (PR-1)
```

PR-1 landed the last two. `CORPUS_ENVIRONMENT` and `RETRIEVAL_PATH` are a small follow-up.

`EXP-P8-BASELINE` stands, unmodified, as **a local Path-A experimental record**. It is not
production performance and must not be presented as such.

### Taxonomy

~~Unchanged and still blocked: TD-04, TD-06, TD-07, TD-01 `technical drawing` / `GD&T` /
`drawing padhna`.~~

**CORRECTED 2026-08-18.** TD-01, TD-02, TD-03, TD-04 and TD-06 are **RATIFIED AND APPLIED**
(owner-direct; see the banner and §0.1 of the master plan). **TD-07 is the only taxonomy
decision still blocked.** TD-05 stays split. `finishing` stays pending. The generic aliases —
`cad`, `inspection`, `gauge`, `assembly`, `welding`, `fitting` — remain downstream of the
taxonomy boundary and are **not** to be cleaned up.

D0 adds one consideration: under Path B those aliases are mostly unreachable anyway (10
skills). Their risk is entirely a **Path A** risk, which strengthens the case for settling
the boundary before Phase B rather than after.

**A second Path-A-only consideration now applies, and it points the same way.** The applied
merges deprecated four skills and minted one, `skill_drawing_reading`, with **zero
`job_domain_skill` edges**. Path B ignores all of this — it reads `skill_alias.domain_id` and
never joins `job_domain_skill`, so production's live behaviour is untouched. Under **Path A**
the same corpus loses 8 previously-reachable drawing-reading aliases and gains none, because
`canonicalAliasRows` requires both `s.status = 'active'` and the edge join. So the deployment
decision D0 recommends would import a defect that the path it replaces does not have. That is
not an argument against Path A; it is an argument that **Stage B must not run until the
zero-edge condition is measured and explicitly decided** — see R19 in the risk register. The
edge re-point remains unauthorized.

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| D-1 | Phase B deploys a taxonomy whose boundaries are still unsettled, then a merge changes skill ids in production | Taxonomy decisions gate Phase B. AI #935 / Mobile #936 first |
| D-2 | Phase B silently changes Path B's 22-alias universe | Additive-only; Path B result set pinned bit-identical before/after |
| D-3 | Shadow doubles query load on the canonicalization path | Flagged, sampled, one extra query bounded by the same `LIMIT` |
| D-4 | Path A returns empty where Path B returned a match (domain match fails, or no edge) | Explicit fallback in Phase E; empty-rate is a Phase D metric |
| D-5 | Production's 76 vectors have NULL `embedding_model`, so Path A candidates could mix models | Re-embed under provenance, or exclude unattributed vectors from the target universe |
| D-6 | `unresolved_phrase` cannot record a canonical-scoped miss | Known and documented; needs `job_domain_id` on that table before Phase E |
| D-7 | The decision is made on an unverified flag state | **D0-Q1 / D0-Q2 must be answered first** |

---

## 8. Updated DAG

```
  D0 DECISION  (this document + D0-Q1/Q2)          ← YOU
        ↓
  PR-1 gate repair ✅ #953      PR-2 investigation ✅ #954
        ↓
  RETRIEVAL_PATH + CORPUS_ENVIRONMENT on experiment records   (safe, autonomous)
        ↓
  local dev-env repair: normalize + embed domain aliases      (isolated, needs authorization)
        ↓
  ══════════ PHASE 8 completion (local, Path A) ══════════
  ✅ TD-01/02/03/04/06 ratified (OWNER) + applied · TD-05 deferred
     TD-07 still open                                          ← TRAINER + PRODUCT
        ↓
  ✅ AI #935 (#950) → Mobile #936 (#941/#951) → merges (#940/#948/#957)
        ↓
  offline Path-A replay on frozen main — shadow evidence + TD-01 zero-edge (R19)
        ↓                      ↓
      EVAL-E1            alias cleanup + generic aliases → EVAL-E2
        ↓
  election → verify → retrieval predicate → EVAL-E3
        ↓
  fixture v3 (trainer) → canonical labels → embedding → EVAL-E4/E5
        ↓
  RE-BASELINE (explicit) → EVAL-E6
        ↓
  ══════════ PHASE 9: production parity ══════════
  Stage A observe → B backfill → C shadow → D parity → E switch → F window → G retire
        ↓
  ══════════ PHASE 10: activation ══════════
  promotion → canonicalization ON → domain-edge pilot → wider rollout
```

Phase 8 finishes **locally on Path A**. Phase 9 is the production parity programme. Phase 10
is activation. Promotion and canonicalization move to Phase 10 because, per §6, promotion
against a path production does not execute proves nothing.

---

## 9. Phase contract additions

Both adopted verbatim:

> **No retrieval experiment may be used as evidence for production unless the experiment
> proves equivalence of corpus, retrieval path, retrieval semantics, model/version, and
> freshness fingerprint.**

> **No promotion may occur merely because the skill corpus passes evaluation. The evaluated
> retrieval path must be the path production actually executes, or a formally validated
> parity/shadow path.**

Under the second rule, **no promotion is currently permissible on any evidence that exists**,
because every record measures Path A and production executes Path B.

---

## 10. Exact next authorization required

1. **Answer D0-Q1 and D0-Q2** — the deployed values of `SKILL_CANONICALIZE_ENABLED` and
   `DOMAIN_MATCH_ENABLED`. I cannot read production env.
2. **Ratify or reject the Path A recommendation.**
3. *(optional, small)* authorize the local dev-environment repair —
   `db:normalize:aliases --apply` + `db:embed:domains` against **docker only**, on a
   disposable database, never the authoritative corpus behind `EXP-P8-*`. ~92 provider
   requests; commands and dry-runs prepared, nothing executed.

Nothing else is requested. Election, predicate, alias writes, demotions, taxonomy merges,
embedding, normalization of the authoritative corpus, fixture changes, re-baselining,
promotion, canonicalization and the 4,071-domain surface all remain **blocked**.

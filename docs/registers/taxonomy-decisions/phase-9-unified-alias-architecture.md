# Phase 9 — Unified alias architecture: one lifecycle for job-domain and skill aliases

> **Design only.** No mutation, no provider call, no flag change. Measured 2026-08-18.
> Follows the [D0 decision](./PHASE-9-D0-PRODUCTION-RETRIEVAL-DECISION.md) ·
> [PR-1 #953](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/953) ·
> [PR-2 #954](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/954)

---

## 1. The directive, and what the evidence says about it

**Directive:** do not refactor the older canonicalization code. Treat *all* aliases — job
domains and skills — with one fresh, uniform pipeline.

**Adopted.** With one correction that makes it cheaper and safer than building from nothing:

> The job-domain side is **already a correct, verified implementation of exactly this
> lifecycle**, running in production on 9,121 rows. It is not legacy. The thing that
> diverged is the *skill* side, and the thing to delete is the legacy `domain_id` retrieval
> path.

Verified in production, read-only, today:

| Check | Result |
|---|---|
| Stored `is_searchable` vs recomputed election | **9,121 rows, 0 mismatches** |
| Searchable rows missing an embedding | **0** |
| Embedding model | `gemini-embedding-001` on **all 9,121** |
| Non-searchable, by reason | 3,989 shadowed ISCO units (deliberate) + 46 duplicate-election losers |
| Domains reachable | 3,515 |
| `worker_profiles` | 2 rows, both with `job_domain_id` **and** `job_domain_match_status` |

So "afresh" means: **generalize the proven domain lifecycle to skills, and delete the legacy
path** — not reinvent a lifecycle that already works on the larger table.

---

## 2. The two tables today

| | `job_domain_alias` (prod) | `skill_alias` (prod) | `skill_alias` (local) |
|---|---|---|---|
| rows | 9,121 | 98 | 328 |
| `text_norm` | 9,121 | **0** | 328 |
| `is_searchable` | 5,086 *(verified correct)* | **0** | 197 *(unverified election)* |
| embedded | 9,121 | 76 | 295 |
| `embedding_model` | `gemini-embedding-001` | **NULL ×98** | `gemini-embedding-001` |
| HNSW index | **PARTIAL** `WHERE is_searchable` | non-partial | non-partial |
| Election runner | `normalize-job-domain-aliases.ts` — elects inline | none until PR #938 | normalizer only, election deliberately deferred |
| Election reasons | 3 (eligibility, shadowing, dedupe) | 1 (dedupe) | 1 |

**The asymmetry is the defect.** Two tables, one concept, two runners, two meanings for the
same column, one partial index and one not. Every bug in this workstream lived in that gap:
the flag that governs nothing on skills, the predicate that would have hidden 98 aliases,
the election that no gate could distinguish from an oversight.

---

## 3. Target: one lifecycle, both tables

```
 raw ──▶ normalized ──▶ elected ──▶ embedded ──▶ retrievable
```

| State | Column | Meaning | Set by |
|---|---|---|---|
| raw | `text_norm IS NULL` | not processed | insert |
| normalized | `text_norm` | has an L0 key, via `normalizeOccupationText` — **one definition, both tables** | the normalizer |
| elected | `is_searchable` | this row is the retrieval representative for its `(parent, text_norm, lang)` group **and** its parent is eligible **and** no recorded demotion applies | the elector |
| embedded | `embedding` + `embedding_model` + `embedded_at` | has a vector, with provenance | the embedder |
| retrievable | *derived* | elected ∧ embedded ∧ parent active | retrieval SQL |

### Election: three reasons, generalized

The domain side's three reasons become the shared model. Skills get all three; two are
currently no-ops for them, and saying so explicitly is better than a second dialect.

| # | Reason | `job_domain_alias` | `skill_alias` |
|---|---|---|---|
| 1 | **Parent eligible** | `selectable ∧ status='active'` | `status IN ('active','provisional')` — provisional stays elected so promotion is a status flip, not a re-election |
| 2 | **Parent not shadowed** | ISCO unit with selectable NCO children | no hierarchy today → always true, stated not omitted |
| 3 | **Group representative** | `row_number() = 1` over `(parent, text_norm, lang)` | identical |
| 4 | **No recorded demotion** | *new, both tables* | the `fitting`/`gauge` class — an explicit decision record, never inferred |

Reason 4 is new and comes straight from PR #938's finding: a hidden row and an unprocessed
row are byte-identical, so intent must come from outside the table.

### Retrieval predicate, both tables

Both HNSW indexes become **partial** `WHERE is_searchable`, and both retrieval paths carry
the matching predicate. That is already true for domains. For skills it is only safe *after*
normalization and election — which PR #938's readiness guard enforces and PR #953's
`PRODUCTION_RETRIEVAL_SEMANTICS` pin couples to the SQL.

---

## 4. What gets built, and what gets deleted

### Built fresh — `packages/db/src/alias-lifecycle/`

A single engine parameterized by table, not two runners:

```ts
interface AliasTable {
  table: "job_domain_alias" | "skill_alias";
  parentTable: "job_domain" | "skill";
  parentKey: "job_domain_id" | "skill_id";
  eligibility: SQL;          // reasons 1 + 2, per table
  tieBreak: SQL;             // embedded first, shortest text, lowest id — shared
}
```

- `normalize(table)` — fills `text_norm`. Manifest + sha256 + four in-transaction guards,
  the discipline proven by the 131-row write.
- `elect(table)` — computes `is_searchable` from the four reasons; emits a decision manifest
  with `winner_id` / `loser_reason` / `decision_source` per row.
- `embed(table)` — batched at 100 texts/request, provenance stamped, `--plan` first.
- `verify(table)` — recomputes election and reports mismatches. **This is the check that
  proved production's domain side sound (0/9,121), and it becomes routine.**

One normalizer definition (`normalizeOccupationText`), one tie-break, one manifest format,
one guard set, one fingerprint (PR-1 already covers all five components).

### Deleted, not refactored

| Surface | Action |
|---|---|
| `legacyAliasRows` in `skills.repository.ts` | **delete** once Path A is live |
| the `legacy` arm of `AliasSearchScope` + `toAliasSearchScope` | **delete** |
| `skill_canonicalize_default_domain = "cnc-machining"` | **delete** — replaced by the `job_domain_id` from domain match |
| `LEGACY_ANCHOR_SKILL_DOMAIN` in `job-postings.service.ts` | **delete** — needs a real `job_domain_id` writer first |
| `skill_alias.domain_id` reads | retire; **column stays** (CLAUDE.md §10, never drop) |

Deletion order matters: the legacy arm goes **after** Path A serves production, not before.
Until then it is the only thing answering, and removing it early is an outage, not a cleanup.

---

## 5. Production env answer

### `SKILL_CANONICALIZE_ENABLED` → **`false`**. Keep it off.

Turning it on today activates Path B, whose entire reachable universe is **22 embedded
aliases across 10 skills** — every caller hard-codes `cnc-machining`. That is not a soft
launch, it is wiring a worker's profile to a tenth of a catalogue. It stays `false` until
Phase 10, after the corpus is deployed, elected, embedded and parity-verified.

### `DOMAIN_MATCH_ENABLED` → **`true`, and it appears to already be true.**

Evidence: both `worker_profiles` rows carry `job_domain_match_status`, a column only the
domain-match path writes. Please confirm the deployed value rather than relying on my
inference.

Keeping it on is right, and the verification above is why: the surface it reads is complete
and provably correct — 0 election mismatches, 0 searchable rows without a vector, one model
across all 9,121. It is the one part of this pipeline that is production-ready today, and it
produces the `job_domain_id` that Path A needs.

### Summary for the GitHub Actions secrets

| Variable | Now | Phase 10 |
|---|---|---|
| `DOMAIN_MATCH_ENABLED` | `true` *(confirm current)* | `true` |
| `SKILL_CANONICALIZE_ENABLED` | **`false`** | `true`, as its own change |

**No secret change is requested right now.** If both already hold these values, do nothing.

---

## 6. Sequence

| # | Step | Env | Mutates | Auth |
|---|---|---|---|---|
| 1 | Confirm the two flag values | prod | no | you |
| 2 | Build the unified lifecycle engine + tests | — | no | merge |
| 3 | `verify()` both tables in prod, read-only | prod | no | autonomous |
| 4 | Repair local dev domain surface on a **disposable** DB | local | yes | you |
| 5 | Trainer taxonomy decisions | — | no | **trainer** |
| 6 | AI #935 → Mobile #936 → backend merges | — | code | you |
| 7 | Normalize + elect + verify `skill_alias`, local | local | yes | you |
| 8 | Deploy taxonomy corpus + edges to prod (additive) | prod | yes | you |
| 9 | Normalize + elect + embed `skill_alias` in prod | prod | yes + provider | you |
| 10 | Partial HNSW on `skill_alias`; predicate on Path A | prod | migration | you |
| 11 | Wire canonicalization to `job_domain_id`; delete the legacy arm | prod | code | you |
| 12 | Parity verify → `SKILL_CANONICALIZE_ENABLED=true` | prod | flag | you |

Steps 2 and 3 are safe and autonomous. Everything from 4 on needs authorization.

---

## 7. Unchanged

Blocked: TD-04, TD-06, TD-07, TD-01 `technical drawing` / `GD&T` / `drawing padhna`. TD-05
split. `finishing` pending. Generic aliases (`cad`, `inspection`, `gauge`, `assembly`,
`welding`, `fitting`) stay until the taxonomy boundary is settled.

Frozen evidence: `EXP-P8-BASELINE` (R@1 0.9912, MRR 0.9956 — **local, Path A**),
`EXP-P8-CANONICAL-LABEL`, the normalization manifest, the post-normalization verification,
the proposed election manifest, GP-04, all Phase 5/6/7 records.

Floor 0.75 · NO_REGRESSION enforced · canonicalization OFF · nothing promoted · 4,071-domain
surface untouched.

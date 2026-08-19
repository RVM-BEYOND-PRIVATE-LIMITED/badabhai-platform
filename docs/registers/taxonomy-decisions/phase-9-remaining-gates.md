# Phase 9 — the remaining gates, and exactly who can close each

> **Updated 2026-08-19 (third pass).** `0078` is applied and verified, so **S3-C is EXECUTED**.
> Three of the original five gates are now closed by measurement. What remains is two taxonomy
> judgement calls, one product/trainer gap, and two host-only actions.
>
> Everything read-only was run against production. The two production writes made this pass —
> applying `0078` (owner) and stamping 76 `embedding_model` values (proven, never assumed) — are
> recorded below with their evidence artifacts.

| # | gate | blocked on | state |
|---|---|---|---|
| 0 | `0078` / S3-C | — | ✅ **APPLIED & VERIFIED** — object-by-object, write path exercised |
| 1 | Embedding provenance (76 unstamped rows) | — | ✅ **CLOSED** — proven `gemini-embedding-001`, stamped |
| 2 | `cnc-programming` scope decision | **product / taxonomy owner** | ⏸ quantified against production |
| 3 | 11 provider evaluation cases | — | ✅ **EXECUTED** — 11 real calls; replay gap closed; harness defect found and fixed |
| 4 | 5 TD-01 trainer slots | **trade trainer** | ⏸ worksheet ready |
| 5 | TD-07 | **product + trainer** | ⏸ worksheet ready, five options costed |
| 6 | R38 residual | **host-only** | 🔴 open — CD cannot fix it (see below) |

---

## 0. `0078` — applied, and verified rather than assumed

The previous pass found `0078` missing while the code that needs it was already deployed. It is
now applied. Verified object-by-object rather than by report:

| object | state |
|---|---|
| `unresolved_phrase.job_domain_id` | `text`, nullable |
| `unresolved_phrase_scope_uq` | `(scope, phrase, domain_id, job_domain_id, lang) **NULLS NOT DISTINCT**` |
| `unresolved_phrase_one_domain_chk` | `CHECK ((domain_id IS NULL) OR (job_domain_id IS NULL))` |
| `unresolved_phrase_job_domain_id_idx` | btree on the FK column |
| FK | `job_domain(job_domain_id)`, `ON DELETE NO ACTION` |
| rows | **9 preserved**, summed `count` 10, `first_seen`/`last_seen` untouched |

`pnpm --filter @badabhai/db db:audit:schema-contract` → **`ready for the code on main? = YES`**.

**The write path was then exercised against the real production schema**, inside a transaction
that was rolled back. Row count and summed `count` were identical before and after, so production
carries nothing from the exercise:

| behaviour | result |
|---|---|
| canonical write (`job_domain_id` set) | upserts — the shape that was impossible before 0078 |
| same phrase, **different** job domain | **distinct row** — the entire point of widening the key |
| repeat of the same (phrase, domain) | dedupes onto one row, `count` increments |
| legacy write (`domain_id` set) | unchanged |
| occupation write (both NULL) | dedupes onto one row — `NULLS NOT DISTINCT` is doing its job |
| both set | refused by `unresolved_phrase_one_domain_chk` |
| bogus `job_domain_id` | refused by the FK |

The 9 rows carry `last_seen` no later than 2026-08-17, which corroborates the previous pass's
finding that nothing was recorded during the window when the column was missing.

---

## 1. Embedding provenance — CLOSED, and stamped

Proven, not assumed: all 76 production texts matched a known-`gemini-embedding-001` reference at
**cosine ≥ 0.999999978**, against an unrelated-pair control of **0.434–0.783**. Applied with
`db:verify:embeddings --apply`, which stamps only rows it proves and refuses wholesale on any
mismatch, mock, or two-model split.

```
PROVEN 76 (gemini-embedding-001) · worst cosine 1.000000000000 (floor 0.99999)
MISMATCH 0 · NO_REFERENCE 0 · PROVEN MOCK 0
stamped 76 row(s). embedded_at left NULL (unknown, and not invented).
```

Evidence: `packages/db/data/taxonomy/replay/phase-9-provenance-stamp.json`.

**Post-stamp state — both vocabularies now pass the corpus gate:**

| | `skill_alias` | `job_domain_alias` |
|---|---|---|
| embedded | 76 | 9,121 |
| stamped | **76** (was 0) | 9,121 |
| unstamped | **0** (was 76) | 0 |
| PROVEN MOCK | 0 | 0 |
| `would --run be allowed?` | **YES** (was NO) | YES |

No vector was touched — 76 embedded before and after, 98 rows before and after. `embedded_at`
stays NULL on all 76 on purpose: nobody knows when they were written, and a fabricated timestamp
would be the same error the whole exercise avoided.

`db:eval:taxonomy --plan` now reports **`would --run be allowed? = YES`**. That refusal had been
standing since the harness was built.

---

## 3. The 11 provider cases — EXECUTED

A real-call environment turned out to be available locally: the provider key was present, and
`apps/ai-service` runs from source. **Nothing in production or GitHub was reconfigured** —
`skill_embedding` was armed only as a process environment variable on a local uvicorn that has
since been stopped.

```
11 provider requests · all NOT_MOCK · dim 768 · |v| 1.0000
cache: 0 hits, 11 provider requests. Flushed.
```

Evidence: `packages/db/data/taxonomy/replay/phase-9-replay-query-vector-provenance.json`.

**Two guards fired on the way, and both were right.**

1. The spend ledger blocked the first attempt (`spend_store_unavailable`, fail-closed) because
   `AI_SPEND_REDIS_URL=redis://localhost:6379` and on Windows `localhost` resolves to `::1` while
   the Docker bind is IPv4-only. Same class as the production `REDIS_URL` incident: a
   structurally wrong value that passes every presence check. Local dev only — no repo file
   changed.
2. The per-request INR ceiling was never the constraint. Projected cost for one text: **₹0.0000625**.

### The replay gap is closed: 127/127, 0 skipped

**And a harness defect was found in the act of reading the result.** The first full-127 run
reported R@1 0.9829 over 117 scored, down from 0.9912 over 113. That drop was **not real**.

`taxonomy-retrieval-eval.ts` defines `COVERAGE_ONLY_CATEGORIES = {"unembedded_shipped"}` and
excludes those cases from Recall/MRR. `taxonomy-alias-experiment.ts` honours it. The fixture says
so per case — US-04's own note reads *"excluded from headline Recall/MRR — reported as its own
category"*. But `path-a-replay.ts`'s `summarizeReplay` split only on `negative` and had **no
notion of coverage-only at all**, so the moment the last four `unembedded_shipped` queries got
vectors they walked into the recall denominator. Three places agreed; the fourth had never been
told.

Fixed (`coverageOnly` threaded from the case category, imported from the one shared set rather
than re-declared) and pinned by 8 tests. Corrected numbers:

| | baseline (116 replayed) | full 127, harness bug | full 127, corrected |
|---|---|---|---|
| cases | 116 | 127 | **127** |
| skipped | 11 | 0 | **0** |
| scored | 113 | 117 | **113** |
| hits | 112 | 115 | **112** |
| **R@1** | 0.9912 | 0.9829 | **0.9912** |
| MRR | 0.9956 | 0.9872 | **0.9956** |
| Path A false positives | 0 | 0 | **0** |
| Path A false negatives | 0 | 1 | **0** |
| coverage reached (Path A) | — | — | **3 / 4** |
| coverage reached (Path B) | — | — | **1 / 4** |

**Retrieval quality did not move.** R@1, MRR and hits are identical to the baseline; the extra 11
cases were never scoring cases. The report now prints `scored` beside R@1, because a recall figure
whose denominator is invisible is exactly how 113 and 117 came to be compared as if they described
the same set.

Corrected report: `phase-9-path-a-replay-FULL-127-COVERAGE-CORRECTED.json`.
The earlier `phase-9-path-a-replay-FULL-127-PRE-PROMOTION.json` is **superseded but retained** —
evidence is not deleted because it turned out to be wrong; it is the record of what the harness
said before the defect was found.

**The three genuine findings from the provider run survive the correction:**

- **Path A's cross-domain isolation holds — 0 false positives across all 10 XD cases**, 7 of
  which had never been scoreable. This is the safety property (a query from a foreign trade must
  return nothing) and it is the strongest single result of the pass.
- **Path B leaks: 2 false positives** on those same cases, where Path A returns nothing. First
  time this has been quantified, and it is an argument for Path A that did not exist before.
- **US-04 is a COVERAGE gap, not a ranking miss** — and it still needs a taxonomy owner.
  Path A reaches 3 of the 4 shipped-and-reused-only skills; US-04 is the one it does not.
  Query `"dimensional inspection"` in `jd_nco_7313_2601` expects `skill_quality_control` and
  Path A returns `skill_drawing_reading`.

  The fixture's own note explains how it got here: TD-02 re-pointed the case from the dissolved
  `skill_dimensional_inspection` to `skill_quality_control`, and rescoped it to
  `jd_nco_7313_2601` because *"`skill_dimensional_inspection`'s old domain `jd_nco_7543_2001` has
  no `skill_quality_control` edge"*. `skill_quality_control` is **shipped-and-reused-only** — it
  has no locally-authored `skills.jsonl` record — so the canonical corpus has nothing of its own
  to retrieve. Whether that is a corpus gap to fill or a fixture expectation to retire is a
  taxonomy judgement. **DC-18 is the standing warning against engineering deciding which.**
  Referred, not resolved.

---

## 2. `cnc-programming` — quantified, still a taxonomy decision

Production holds the PRE-merge state (`skill_gdt_reading` and `skill_cad_interpretation` both
`active`; `skill_drawing_reading` does not exist there), so this is a forecast of S3-D measured on
what is deployed.

**Lost under `cnc-programming` at S3-D** — `skill_cad_interpretation`'s 4 aliases: `CAD` (en,
embedded), `technical drawing` (en, embedded), `read engineering drawings` (en, embedded),
`drawing padhna` (**hi, NOT embedded**).

**Surviving** — 3 skills, 10 aliases (8 embedded), none about reading a drawing:
`skill_cam_software`, `skill_cnc_programming`, `skill_program_editing`.

| option | cost | consequence |
|---|---|---|
| **A — accept the loss** | none | A CNC programmer stops matching drawing-reading phrases for the S3-D → S10 window |
| **B — legacy alias row under `cnc-programming`** | one row **+ one embed call** | Closes it. Additive, reversible |
| **C — treat it as moot** | none | Only defensible if S10 is near. **Nobody has dated S10** |

Two corrections still standing from the previous pass: the retrievable loss is **3, not 4**
(`drawing padhna` has no embedding, so Hindi is unserved there today), and **B is not one data
row** — an unembedded alias is not retrievable, so it costs a row *plus* an embedding call.

---

## 4 & 5. TD-01 slots and TD-07 — worksheet ready

**`phase-9-trainer-worksheet.md`** — trade names for all 12 domains, the 8 aliases that must not
be reused, the competitor questions, and TD-07 costed five ways. Every slot deliberately empty.

---

## 6. R38 — the residual is host-only, and CD cannot reach it

Sharpened this pass and it is worse than "recreate the containers": CD runs
`docker compose … --no-deps api`, and `docker-compose.staging.yml` states outright that a bare
`up -d` is what would start the profile-less `postgres`/`adminer`. **No deploy ever starts them,
so no deploy will ever re-create them with the corrected loopback binds.** The merged base-file
fix guards the next bare `up -d`; it is not a remedy for what is running now.

Pinned by `deploy-workflow-taxonomy.guard.test.ts`, which asserts the `--no-deps api` invariant so
this reasoning cannot silently stop being true.

---

## Flags, unchanged

`DOMAIN_MATCH_ENABLED=false`, `SKILL_CANONICALIZE_ENABLED=false`, `AI_ENABLE_REAL_CALLS=true`,
`AI_REAL_CALL_TASKS=profiling_chat_turn` (compose default; not bridged from GitHub — asserted by
test). No taxonomy seed, no `job_domain_skill` mutation, no edge change, no flag change, no TD-07
decision, no invented trainer ground truth.

## The next gate

With `0078` applied, provenance closed and the replay gap shut, the next Phase-9 activation gate
is **S3-D** — and it is now blocked on exactly two things, both human:

1. the `cnc-programming` A/B/C decision (§2), and
2. a ruling on **US-04** (§3) — whether TD-02's merge target or the fixture is wrong.

Neither is engineering's call. Everything mechanically checkable ahead of S3-D is green.

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
| 3 | 11 provider evaluation cases | — | ✅ **EXECUTED** — 11 real calls, replay gap closed |
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

| | before | after |
|---|---|---|
| replayed | 116 | **127** |
| skipped (no cached query vector) | 11 | **0** |
| scored | 113 | **117** |
| Path A R@1 | 0.9912 | **0.9829** |
| Path A MRR | 0.9956 | **0.9872** |
| Path A false positives | 0 | **0** |
| Path A false negatives | 0 | **1** |
| Path B false positives | 0 | **2** |

Report: `packages/db/data/taxonomy/replay/phase-9-path-a-replay-FULL-127-PRE-PROMOTION.json`.

**The drop is the gap closing, not a regression** — exactly as the contract predicted. The 11
cases were never ordinary recall cases: 7 are `cross_domain_isolation` (expected skill `null`) and
4 are `unembedded_shipped`. The 4 entered scoring; one of them misses.

**Three findings that were invisible while these cases were unscoreable:**

- **Path A's cross-domain isolation holds — 0 false positives on all 7 XD cases.** This is the
  safety property (a query from a foreign trade must return nothing), and it had never been
  measured on the hardest cases. It passes.
- **Path B leaks: 2 false positives on the same 7 cases.** The legacy path returns a skill where
  Path A correctly returns nothing. First time this has been quantified, and it is an argument
  for Path A that did not exist before.
- **US-04 is a genuine Path A miss, and it needs a taxonomy owner, not a fix.**
  Query `"dimensional inspection"` in `jd_nco_7313_2601` (Final Quality Inspector) expects
  `skill_quality_control`; Path A returns `skill_drawing_reading`. It is the single
  `top1_changed` case in the TD-01/02/03 impact table: pre-merge it returned
  `skill_dimensional_inspection`, which **TD-02 deprecated**. So either TD-02's merge target is
  wrong for this query, or the fixture's expectation is stale. **DC-18 is the standing warning
  against engineering deciding which** — a case that read as a model failure for two phases turned
  out to be a fixture opinion. Referred, not resolved.

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

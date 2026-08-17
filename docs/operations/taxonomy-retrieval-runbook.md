# Taxonomy retrieval: evaluation, scale, and provider throughput

Operating notes for the Domain→Skill taxonomy retrieval path (ADR-0030 / TAX-3..TAX-6).
Covers the three harnesses in `packages/db`, the experiment registry, and the measured
recommendations from Phase 6.

Everything here is measured on the controlled 28-domain / 98-skill corpus. The 98 skills
remain **provisional** and the remaining 4,071 domains remain **unauthorised**.

---

## 1. The three harnesses

| Command | Needs a provider? | Writes to the DB? |
| --- | --- | --- |
| `pnpm db:embed:skills` | yes (real path) | `skill_alias.embedding` + provenance |
| `pnpm db:eval:taxonomy` | yes (query embeds only) | nothing |
| `pnpm db:scale:taxonomy` | **no** | only its own sandbox schema |

```bash
# Ground truth vs the corpus. Offline, no DB, no provider.
pnpm db:eval:taxonomy --validate-fixture

# What would run, and whether the stored vectors permit it. DB read-only.
pnpm db:eval:taxonomy --plan

# The measurement. REFUSES to score mock or mixed-model vectors.
pnpm db:eval:taxonomy --run --experiment EXP-EVAL-CORRECTION [--push-langfuse]

# ANN behaviour at scale. Credential-independent; builds and drops its own schema.
pnpm db:scale:taxonomy --plan
pnpm db:scale:taxonomy --run --sizes 1000,2000,5000,9121 --record
pnpm db:scale:taxonomy --teardown
```

`--fixture` and `--experiment` **throw** rather than defaulting when given no value. A
harness that silently measures a different dataset than the operator selected produces a
report that names the wrong instrument, and nothing in the output reveals it.

---

## 2. The experiment registry

`packages/db/data/taxonomy/eval/experiments/<EXP-ID>/<run_id>.json`. One immutable file per
run; `writeExperimentRecord` **refuses to overwrite**, and there is no `--force`.

| Experiment | What it holds |
| --- | --- |
| `EXP-BASELINE` | Phase 5 first real run. Evaluator v1, fixture v1. **Immutable reference.** |
| `EXP-EVAL-CORRECTION` | Phase 6 measurement correction. Same vectors, corrected evaluator + fixture. |
| `EXP-ANN-DEFAULT` | Scale sim at the stock ANN configuration. |
| `EXP-ANN-EF-SEARCH` | Scale sim sweeping `hnsw.ef_search`. |
| `EXP-ANN-ITERATIVE-SCAN` | Scale sim with `hnsw.iterative_scan`. |

Every record names its own instrument — `evaluator_version`, `fixture_version`,
`embedding_model`, and the full `ann` block. `compareExperiments` reports `comparable: false`
when any of those differ, because a delta across an instrument change is not a result.

**Evaluator v1 numbers are not comparable with v2 numbers.** v1 judged
`must_not_return_skill_ids` by top-k membership; v2 judges it by rank relative to the
expected skill and reports the semantic and structural measures separately. See the header
of `taxonomy-retrieval-metrics.ts`.

---

## 3. ANN configuration — the Phase 6 recommendation

**Recommendation: change nothing.** Not deferred — measured as unnecessary for this path.

### What was measured

Corpus grown 197 → 1,000 → 2,000 → 5,000 → 9,121 aliases, holding production shape
(~8.5–9 skills per domain at every size, so the domain filter stays as selective as it will
be in production: **0.098%** at 9,121). Padding is Gaussian perturbation of real vectors at
a target cosine of 0.85 — dense enough to genuinely compete. No provider involved; exact-NN
ground truth is derived by disabling index scans.

### The scoped query — the one production actually runs

```
Limit > Sort > Nested Loop > Bitmap Heap Scan > Bitmap Index Scan (x2)
indexes: <domain btree>, <skill btree>          <-- HNSW is absent
```

At **every** size, up to and including 9,121 rows:

- **HNSW is never used.** The domain filter reduces the candidate set to ~9 rows, so the
  planner reaches them through the `job_domain_skill` btree and then sorts those 9 by exact
  distance. This is not a small-table artifact that scale will fix — it is what selectivity
  does, and selectivity does not decay as the taxonomy grows, because production grows by
  adding domains rather than by enlarging them.
- **Recall vs exact NN is 100%**, trivially: the scan *is* exact.
- Execution time is **0.23–0.43 ms** at 9,121 rows, flat against corpus size.
- **Zero** empty results; every query returns its domain's full skill set.
- `ef_search` and `iterative_scan` are **inert** on this path — they cannot matter to a plan
  that never touches the index.

**This resolves the Phase 5 ANN caveat, in the reassuring direction and for an unexpected
reason.** Phase 5 reported Recall@1 99.1% and warned the number was an upper bound because
`EXPLAIN` showed a Seq Scan at 197 rows. The upper bound holds at production scale too — not
because HNSW is accurate here, but because the scoped query is exact at both sizes.

### The unscoped query — not currently on the retrieval path

Included because any future global search would land here:

- HNSW **is** used from ~2,000 rows up, and it is worth it: 0.8 ms versus 61 ms for the
  exact seq scan at 9,121 (≈76× faster).
- Recall against exact NN degrades with scale — 100% at 2k, 94.5% at 5k, **67–82% at 9,121**
  (two samples, n=20 and n=40). Treat the spread as the honest precision; the absolute value
  is a function of the synthetic padding density and is **not** a production forecast.
- **`ef_search` does not recover it.** 20 → 400 moved recall not at all. That points at the
  graph build (`m`, `ef_construction`) rather than search breadth, and it means "raise
  ef_search" is not the lever it is usually assumed to be.
- **`ef_search` silently caps the row count below your `LIMIT`.** At `ef_search=20` a
  `LIMIT 40` returned exactly 20 rows. Any unscoped path must set `ef_search` ≥ the rows it
  needs, or it will quietly under-return.
- `iterative_scan` changed nothing, as expected: it exists to repair *filtered* HNSW
  shortfall, and no query here combines HNSW with a filter.

### If a global (unscoped) search is ever introduced

Re-run this experiment first. The scoped path's exactness is what makes today's numbers
safe, and an unscoped path forfeits it.

---

## 4. Provider throughput for the offline corpus embed

Two quotas pull in opposite directions and each has its own control. Getting this backwards
is easy and was got backwards once already.

| Quota | Control | Why |
| --- | --- | --- |
| per-DAY **requests** (1,000 free tier) | keep `AI_EMBED_REQUEST_BATCH` **large** | 100 texts/request puts 9,121 aliases at ~92 requests; 1 text/request needs 9,121 and takes ten days |
| per-MINUTE **texts** | `AI_EMBED_TEXTS_PER_MINUTE` (pacing) | shrinking the batch spends the same text budget across *more* requests — strictly worse for the daily quota |

**Batch size is not the throttle control.** Measured across 201 real Phase 5 observations: a
100-text request succeeded (3,594 ms) while a 50-text one was refused. What predicts refusal
is how many texts went out in the preceding minute. The largest 60-second window whose
requests all succeeded carried 148 texts.

**Refused attempts consume the quota too.** A 50-text request was rejected at +211 s when
only 55 texts had *succeeded* in the prior minute — but 194 had been attempted and 429'd in
that same window. This is why the limiter charges failed attempts, and why a 429 waits out
the rate window (`AI_EMBED_RATE_LIMIT_COOLDOWN_SECONDS`, default 60) instead of backing off
exponentially inside it.

### Recommended free-tier configuration

```bash
AI_EMBED_REQUEST_BATCH=100        # ~92 requests for the full corpus
AI_EMBED_TEXTS_PER_MINUTE=90      # 10% headroom under the ~100/min observed
AI_EMBED_MAX_RETRIES=2
```

Full corpus: ~92 requests, ~101 minutes, no refusals. Per-text price is identical at any
batch size, so this costs nothing extra.

`AI_EMBED_TEXTS_PER_MINUTE` defaults to **0 (unpaced)** deliberately — a paid tier has a far
higher quota and must not be throttled to a free-tier number by an upgrade. The retry policy
*is* on by default, because unlike pacing it is an improvement at every tier.

### Retry safety

- Bounded: `1 + AI_EMBED_MAX_RETRIES` attempts total, and no sleep after the final one.
- Only failures where the provider demonstrably did no work are retried — 429, 5xx, connect
  errors.
- A **read timeout is not retried by default**: the request was sent and the outcome is
  unknown, so a retry can pay for the same texts twice. `AI_EMBED_RETRY_ON_READ_TIMEOUT`
  opts in; the resumable runner picks the row up next pass at no cost.
- An isolatable 4xx is **bisected, not retried** — one bad text should not discard the 99
  good embeds beside it.
- Failures stay visible in Langfuse as `WARNING` observations carrying `attempts`,
  `waited_seconds` and `rate_limited`. Throttling that was *survived* is recorded too: a run
  that only got through by waiting is healthy by every counter and is still telling you the
  configuration is wrong.

---

## 5. Safety notes

- `db:embed:skills --reset-embeddings` is **global and unscoped**, and it cannot be combined
  with `--batch`. Check which database `DATABASE_URL` points at before running it.
- `db:scale:taxonomy` and `db:embed:skills` both refuse `NODE_ENV=production`.
- The scale sandbox lives in the `taxonomy_scale_sim` schema, has no migration, and is
  dropped by `--teardown`. It never writes to `public.*`.
- The scale harness cannot publish a quality metric: `assertNoSemanticClaim` throws if a
  record built from synthetic vectors carries `recall_at_1`, `recall_at_3`, `recall_at_5`
  or `mrr`.

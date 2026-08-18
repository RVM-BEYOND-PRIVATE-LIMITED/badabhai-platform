# Provider run contract — closing the replay's 11-case gap

> **Status: PREPARED, NOT EXECUTED.** No external request has been made from this environment.
> `AI_ENABLE_REAL_CALLS` is untouched, `docker-compose.yml` is unmodified, and
> `real-call-posture-compose.guard.test.ts` is green. **You execute this**, against an
> explicitly real-call-enabled environment.

---

## 1. The command

```
pnpm --filter @badabhai/db exec tsx src/embed-replay-queries.ts --apply \
  --evidence=data/taxonomy/replay/phase-9-replay-query-vector-provenance.json
```

Or via the registered script from `packages/db`:

```
pnpm db:embed:replay-queries --apply --evidence=<path>
```

**Dry run is the default.** Without `--apply` it prints the plan and calls nothing — that is the
output reproduced in §3 below, and it is the run that has already been performed.

## 2. Why this gap matters

`replay-path-a.ts` scores only cases whose query vector is already cached. The Phase-8 cache is
a partial artifact of a run that **exhausted its daily request quota mid-way**, so 11 of 127
cases are unscoreable — and all 11 are REVIEWED, i.e. **12.5% of the entire scoreable set**, the
graded portion. Two sit in domains the merges touched (`XD-06 @ jd_nco_7543_2001`,
`US-04 @ jd_nco_7313_2601`), so the exclusion is not neutral.

## 3. Exactly 11 requests, and exactly these inputs

The endpoint sends **one text per request**, so 11 texts cost 11 requests. Nothing is batched
and nothing else is sent.

| # | case | scoreable | job_domain_id | text sent |
|---|---|---|---|---|
| 1 | `XD-01` | reviewed | `jd_nco_7112_0601` | `G code program editing` |
| 2 | `XD-02` | reviewed | `jd_nco_4321_0601` | `fanuc controller` |
| 3 | `XD-03` | reviewed | `jd_nco_7223_6002` | `mortar mixing` |
| 4 | `XD-06` | reviewed | `jd_nco_7543_2001` | `brick laying` |
| 5 | `XD-07` | reviewed | `jd_nco_7223_6003` | `स्टॉक गिनती` |
| 6 | `XD-09` | reviewed | `jd_nco_7112_0100` | `hardness testing of castings` |
| 7 | `XD-10` | reviewed | `jd_nco_7231_0100` | `barcode scanning` |
| 8 | `US-01` | reviewed | `jd_nco_7223_6002` | `fanuc` |
| 9 | `US-02` | reviewed | `jd_nco_7223_6003` | `cnc programming` |
| 10 | `US-03` | reviewed | `jd_nco_7212_0301` | `tig welding` |
| 11 | `US-04` | reviewed | `jd_nco_7313_2601` | `dimensional inspection` |

### No PII, and not by luck

Every one of the 11 is a **committed fixture query** from
`packages/db/data/taxonomy/eval/retrieval-v2.jsonl` — generic trade vocabulary, authored as
evaluation ground truth and already in the repository in plaintext. **No worker text, no
transcript, no profile field, no name, no phone number, and nothing derived from a real
conversation crosses the boundary.** The runner's input set is the fixture and nothing else: it
opens no database connection, so it has no access to `workers`, `worker_profiles`, or any
message table. That is a structural property of the runner, not a policy applied to it.

The request body per call is:

```json
{ "items": [ { "alias_id": "00000000-0000-4000-8000-000000000000", "text": "<one of the 11>" } ] }
```

The `alias_id` is a fixed all-zero UUID placeholder — these are query strings, not alias rows,
so no real identifier is sent.

## 4. Provider and model

| | |
|---|---|
| Endpoint | `POST {AI_SERVICE_URL}/embeddings/skill-alias` (default `http://localhost:8000`) |
| Auth | `x-ai-internal-token` when `AI_INTERNAL_TOKEN` is set |
| Model | **`gemini-embedding-001`**, pinned as `EMBEDDING_MODEL` |
| Dimension | 768 |
| Batching | none — one text per request, by the endpoint's design |

The model is part of the cache key. A model change **misses** rather than silently mixing two
vector geometries, because cosines computed across two geometries look entirely normal and mean
nothing.

## 5. The three guards

1. **`--apply` required.** Dry run is the default; spend is never accidental.
2. **Mock detection, and it aborts — checked two independent ways.** `ai-service` falls back to
   a deterministic `_mock_embedding` when no real provider is configured, and a mock vector has
   the right dimension, the right magnitude, and produces plausible cosines. The runner checks
   the server's own `is_mock` flag **and** re-derives the fallback locally via
   `classifyEmbedding`. The first mock **exits non-zero before `cache.flush()`**, so nothing is
   written. This already fired once, correctly, against the local container.
3. **`budget_stopped`** from the ai-service spend ledger aborts the run.

A 200 response with an empty result set is treated as a **provider** failure (usually a 429
quota refusal), not a malformed response — with that stated in the error, because mislabelling
it cost Phase 8 ten minutes in the wrong layer.

## 6. Cache behaviour

Vectors are written to `packages/db/.embed-cache/vectors.json` — **gitignored on purpose**. It
holds hundreds of 768-float vectors: derived data, regenerable from the provider at any time,
and committing it would invite a reviewer to mistake cached vectors for a measurement.

- Key: `sha256(text)` under the model, so a re-run is a no-op and costs zero requests.
- Current contents: **228 vectors**, all `gemini-embedding-001`.
- After a successful run: **239**. Re-running then reports `MISSING 0` and exits.
- The cache is flushed **once, at the end**, only if every vector passed the mock check.

## 7. Evidence produced

`--evidence=<path>` writes a committed JSON record. It refuses to overwrite an existing file.

```json
{
  "kind": "replay-query-vector-provenance",
  "embedding_model": "gemini-embedding-001",
  "endpoint": "/embeddings/skill-alias (one text per request)",
  "requests": 11,
  "all_not_mock": true,
  "records": [
    { "case_id": "XD-01", "query": "...", "scoreable": true,
      "dimension": 768, "l2_norm": 0.0, "vector_sha256": "...", "provenance": "NOT_MOCK" }
  ]
}
```

**The 768 floats are deliberately NOT recorded** — only the dimension, L2 norm and a sha256 per
vector. That is enough to prove a specific vector was obtained and to detect later drift,
without putting megabytes of derived noise into a diff.

## 8. How the evidence enters the evaluation

The runner writes vectors into the cache; the replay reads that cache. Nothing else connects
them, and no replay code changes.

```
pnpm db:embed:replay-queries --apply --evidence=<path>     # you run this
pnpm db:replay:path-a --vectors=<tsv> --include-provisional --report=<new path>
pnpm db:replay:path-a --vectors=<tsv> --report=<new path>  # production semantics
```

The replay then reports **`127 replayable, 0 SKIPPED`** instead of `116 / 11`, and recall is
computed over **124 positive cases** rather than 113. Report paths must be new — the runner
refuses to overwrite committed evidence.

**Expect the headline numbers to move, and that is the point.** R@1 0.9912 / MRR 0.9956 is
measured over 113 cases with the 11 hardest-to-reach ones absent. Adding them can only be
neutral or worse. A drop is not a regression; it is the gap closing.

## 9. What this run must not become

It closes an **evaluation** gap. It is not a step toward activation and unlocks nothing:
`SKILL_CANONICALIZE_ENABLED` and `DOMAIN_MATCH_ENABLED` stay `false`, no alias is written, no
embedding column is touched, no production row moves, and the legacy retrieval arm stays.

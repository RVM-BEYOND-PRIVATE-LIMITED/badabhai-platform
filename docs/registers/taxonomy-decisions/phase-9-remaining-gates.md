# Phase 9 — the remaining gates, and exactly who can close each

> **Status: PREPARED. Nothing here mutates production.** Written 2026-08-19, after S3-C (D-6)
> closed. Every item below was pushed as far as it can go without inventing ground truth,
> making an unauthorized taxonomy decision, or touching production — and then stopped, with
> the stopping point named.
>
> Read the **Owner** column first. Four of the five items are blocked on a person, not on work.

| # | gate | blocked on | state |
|---|---|---|---|
| 1 | Embedding provenance (the "76 NULL `embedding_model`" rows) | nobody — **advanced below**; one DB read left | ▲ mostly closed |
| 2 | `cnc-programming` scope decision | **product / taxonomy owner** | ⏸ package ready |
| 3 | 11 provider evaluation cases | **you** — needs a real-call environment | ⏸ command ready |
| 4 | 5 TD-01 trainer slots | **trade trainer** | ⏸ slots empty by design |
| 5 | TD-07 | **product + trainer** | ⏸ GAP, unchanged |

---

## 1. Embedding provenance — mock contamination is RULED OUT

**The worry, stated properly.** `corpusBlockReason` refuses to proceed while any embedded alias
carries no `embedding_model`, on the grounds that *"provenance is unknown, so a mock or
foreign-model vector cannot be ruled out."* Two different failures are bundled in that sentence,
and they are not equally serious:

- **mock** — `ai-service` fell back to `_mock_embedding`, a deterministic hash. Mock vectors have
  the right dimension and magnitude and produce entirely plausible cosines, so nothing downstream
  notices. This is the one that would silently invalidate every recall number Phase 8 and 9
  produced.
- **foreign-model** — a real vector from a different model. Also invalidating, because cosines
  across two geometries are meaningless, but far less likely and not silent in the same way.

**Mock is now ruled out, by recompute rather than by trust.** `classifyEmbedding` reproduces
ai-service's `_mock_embedding` exactly and compares all 768 dimensions at 1e-6. Run over the
read-only vector export the Phase-9 replay was scored against:

```
rows parsed   295  (unparseable 0)
PROVEN MOCK   0
NOT_MOCK      295
```

Every vector in the working set is real. **R@1 0.9912 was not measured over mock vectors** —
which was the actual risk, and it is now retired.

**A discrepancy worth recording rather than smoothing over.** That export carries
`gemini-embedding-001` on all 295 rows, yet production's `skill_alias` holds 98 rows of which 76
are embedded, and those 76 are the ones reported as NULL-stamped. So the export is **not** a
read of the same 76 rows — it is a superset from a different snapshot (it spans more than
`skill_alias` alone). The mock finding above is therefore sound for the *evaluation corpus* and
does **not** by itself clear the 76 production rows.

**What is left, and it is one read.** Re-export the production rows and classify them the same
way. No write, no provider call:

```sql
SELECT id, text, embedding_model, embedding
FROM skill_alias
WHERE embedding IS NOT NULL;
```

then `classifyAll(rows)` → `ProvenanceReport`. Expected: `mock: 0`, `unstamped: 76`. If mock is
0 there too, the residual is purely a **stamp** gap, not a data-integrity one — and the decision
becomes whether to backfill the stamp (cheap, safe, additive) or re-embed
(`db:embed:skills --reset-embeddings`, which costs 76 real provider calls and is the only route
that also rules out foreign-model). Recommend the stamp backfill plus a note, unless someone
wants the foreign-model question closed too.

---

## 2. `cnc-programming` — the decision, with the numbers behind it

**Not a canonical domain at all.** The corpus has **28** `jd_*` job domains and `cnc-programming`
is not one of them. It is a **legacy slug** in the `skill.domain_id` / `skill_alias.domain_id`
space — the Path B universe only. This reframes the question: the loss described below exists
only while Path B is still serving, and disappears when the legacy arm is removed at S10.

**What actually happens at S3-D**, from the corpus:

| skill | legacy slug | status after S3-D | aliases |
|---|---|---|---|
| `skill_gdt_reading` | `cnc-machining` | deprecated | 4 |
| `skill_cad_interpretation` | **`cnc-programming`** | deprecated | 3 |
| `skill_drawing_reading` (successor) | **`cnc-machining`** | active | 7 (all of the above, merged) |

`skill_gdt_reading` → `skill_drawing_reading` is a **clean swap**: same slug, so a Path B caller
scoped to `cnc-machining` loses four aliases and immediately regains all seven on the successor.

`skill_cad_interpretation` → `skill_drawing_reading` is **not a swap**. The predecessor is under
`cnc-programming`; the successor is under `cnc-machining`. Path B filters `s.status = 'active'`,
so at S3-D a caller scoped to `cnc-programming` **loses `CAD`, `technical drawing` and
`read engineering drawings` and gains nothing**, because the replacement sits under a slug it
never queries.

**What survives under `cnc-programming`** — 3 active skills, 8 aliases
(`skill_program_editing`, `skill_cam_software`, `skill_cnc_programming`), plus 7 provisional
skills that production semantics do not retrieve anyway.

**The question for the owner:** should a CNC *programmer* be able to match on drawing reading?

| option | cost | consequence |
|---|---|---|
| **A — accept the loss** | none | A CNC programmer stops matching on drawing-reading phrases for the S3-D → S10 window. Arguably a real coverage gap: reading a drawing is not obviously outside that trade |
| **B — add a legacy alias row** for `skill_drawing_reading` under `cnc-programming` | one additive data row, needs authorization | Closes the gap for the window. Additive, reversible, no schema change |
| **C — treat it as moot** | none | Only defensible if S10 is near. **Nobody has dated S10**, so this is currently a bet, not a plan |

**Not decided here.** B is the only option that changes data, and choosing it is a taxonomy
decision, which engineering does not own (CLAUDE.md §16). What engineering can say is that the
gap is **real, small, and time-boxed to the Path B window** — and that C's safety depends
entirely on a date nobody has set.

---

## 3. The 11 provider cases — cannot run from here, and why

Contract unchanged: `phase-9-provider-run-contract.md`. Re-verified today rather than assumed:

- **no ai-service running locally** (`GET localhost:8000/health` — no response);
- **no provider key in this environment**;
- `docker-compose.yml` pins `AI_ENABLE_REAL_CALLS: "false"` as a hard literal, correctly — it is
  the dev-laptop file and there is no box to arm;
- the embed cache holds **228** vectors, exactly as the contract records, so the 11 are still
  uncached and the run is still a no-op-if-repeated.

**One further gate the contract does not stress enough:** embeddings route under the
`skill_embedding` task type, and `AI_REAL_CALL_TASKS` defaults to `profiling_chat_turn` **only**.
So `AI_ENABLE_REAL_CALLS=true` alone is *not* sufficient — the run will return mock and the
runner will abort before writing the cache (which is the guard behaving correctly). The task
list must be widened **for that run**, then put back.

```bash
# On a real-call-enabled environment, NOT the sandbox:
export AI_REAL_CALL_TASKS=profiling_chat_turn,skill_embedding   # widen
pnpm db:embed:replay-queries --apply \
  --evidence=packages/db/data/taxonomy/replay/phase-9-replay-query-vector-provenance.json
export AI_REAL_CALL_TASKS=profiling_chat_turn                    # put it back
```

Then re-run the replay (`--report=` must be a NEW path; the runner refuses to overwrite
evidence). **Expect the headline numbers to fall** — R@1 0.9912 is measured over 113 cases with
the 11 hardest absent. A drop is the gap closing, not a regression.

**Do not run this in a public-log context.** Provider responses and the evidence file are fine
(the file records dimension, L2 norm and a sha256 per vector, never the floats), but the run
needs a key in the environment.

---

## 4. TD-01 trainer slots — 5, empty, and that is the design

`pnpm db:review-pack:td01 --vectors=<tsv>` produces the pack. Every paraphrase slot ships with an
**empty query** and `review_status: "pending_review"`.

This is not an oversight to be tidied up. **DC-18** is the standing example in this repo: a case
that read as a model failure for two phases turned out to be a fixture opinion. A paraphrase
written by the same process that scores it measures nothing. The only cases carrying a query are
`mechanical` ones, where the query *is* the skill's own alias — tautologically correct, weak by
construction, and present only to demonstrate reachability. **They are never to be promoted to
recall evidence.**

Needed from a trade trainer: for each slot, how a worker in *that* domain would describe the
skill without reusing an alias verbatim, then flip `review_status` to `reviewed`.

---

## 5. TD-07 — unchanged, and deliberately not resolved implicitly

Still **GAP**, still product + trainer. S3-A's P8 check exists specifically to stop TD-07 being
closed as a side effect of a deployment stage. Nothing in S3-C touched it.

---

## What closed since the last register update

- **D-6 / S3-C — CLOSED.** Migration 0078: `unresolved_phrase.job_domain_id`, the unique index
  widened to five columns, `unresolved_phrase_one_domain_chk`, and
  `skill.phrase_unresolved_v2`. A canonical-scoped miss can now be recorded, so Path A's failures
  are no longer invisible in the table built to catch failures. **Migration APPLIED to production
  2026-08-19** (owner), ahead of the code reaching the box — which is the required order: the
  repository names `job_domain_id` in every unresolved INSERT, so a database without `0078` fails
  every such write, including the occupation path that runs in live interviews. No taxonomy data,
  corpus, edge or flag changed with it.
- **R38 — code fixed, residual open.** `adminer`, `postgres`, the proxy harness and the e2e
  remap are loopback-bound in the base compose file and pinned by a guard test. The containers
  already running on the box keep their old binds until recreated, and the Lightsail security
  group is still unverified. Both are human actions.

## Flags, unchanged

`DOMAIN_MATCH_ENABLED=false`, `SKILL_CANONICALIZE_ENABLED=false`, `AI_ENABLE_REAL_CALLS=true`,
`AI_REAL_CALL_TASKS=profiling_chat_turn`. No taxonomy seed, migration, embedding, edge mutation
or flag change has been made in production.

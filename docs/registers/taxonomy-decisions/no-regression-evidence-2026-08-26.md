# `NO_REGRESSION` — the first fingerprinted evidence, at ₹0, and the two defects that blocked it

> **Measured 2026-08-26 UTC. Production mutations: NONE · AI spend: ₹0 · nothing promoted, nothing
> activated, `SKILL_CANONICALIZE_ENABLED` untouched and still false.**
>
> Record: `EXP-P9-REGRESSION-FRESH/eval-taxonomy-retrieval-v1-v2-e2-2026-08-26T12_22_35.109Z.json`
> Tests: `regression-evidence.test.ts` (13) · Audit: `pnpm db:audit:gate-evidence`
> Supersedes the cost figure in [`gate-evidence.md`](./gate-evidence.md) and
> [`promotion-and-activation-readiness.md`](./promotion-and-activation-readiness.md).

---

## 0. What changed

| | before | after |
|---|---|---|
| fingerprinted evaluation records | **0** | **1** |
| `NO_REGRESSION` independent blockers | 4 | **2** (freshness on the sweep side, and the score) |
| cost to make the evidence fresh | ₹0.028128 | **₹0.0035** — the evaluation half turned out to be free |
| `EVAL_COVERED` under the runner's default | reported PASS | **BLOCKS 41** — the audit was reading a different fixture from the gate |

**Nothing was weakened.** The 1.0/1.0 bar, the 0.75 floor, the closed `CRITERIA` set and the
unwaivable-staleness rule are byte-for-byte unchanged, and a record with no fingerprint is still
refused — asserted by test.

---

## 1. Defect one: the evaluation computed the fingerprint and threw it away

`judgeRegression` reads `corpus_fingerprint` from the **experiment record**. That is the only
artifact it ever sees.

The evaluator computed the fingerprint all along. It is on the internal run record, and it has
been printed on every run for weeks. It was simply **not copied into the experiment record** —
one missing line in the object literal that `writeExperimentRecord` persists.

So every evaluation ever recorded arrived at the gate with `corpus_fingerprint === undefined`,
which the gate correctly treats as unprovable freshness and refuses. The programme diagnosed
this once already on the *sweep* side and fixed it there; the evaluation side had the identical
defect and went unnoticed because **the number was on screen**. The gate's own remedy —
*"re-run `db:eval:taxonomy --run --experiment`"* — pointed at a re-run that could not have
helped, however many times it was performed.

```ts
// promote-skills.ts — what the gate reads
if (r.corpus_fingerprint === undefined) return none("…carries no corpus_fingerprint…", true);

// taxonomy-retrieval-eval.ts — what the record carried, before
corpus_batch: record.corpus_batch,
model: record.embedding_model,          // ← corpus_fingerprint never appeared
```

**Fixed by copying, never by fabricating:** `null` stays `null`, which cannot clear the gate.

---

## 2. The run was free, and the record says so

Every one of fixture v2's **127 query texts was already in the local embed cache** — a
content-addressed store keyed on `(model, sha256(text))` that three other runners already use.
The evaluator and the floor sweep were the two that did not.

```
pnpm db:eval:taxonomy --run --cache --include-provisional \
  --fixture data/taxonomy/eval/retrieval-v2.jsonl --experiment EXP-P9-REGRESSION-FRESH

  query embeds  = 127 cached, 0 paid (model gemini-embedding-001)
  cost_inr_estimated = 0
```

**Why this is sound and not a shortcut** — the cache's own contract: the embedder is
deterministic for a given model, so a cached vector *is* the current answer rather than a stale
approximation of it. Three properties make it safe here, and each is enforced rather than
asserted:

1. **The key's model comes from the corpus, not from a constant.** Every embedded alias carries
   one `embedding_model` and `corpusBlockReason` has already refused a corpus that mixes them,
   so keying on that value guarantees query vectors and alias vectors share a space. A model
   change *misses* instead of silently mixing two geometries — the failure that looks entirely
   normal while making every cosine meaningless.
2. **A miss still goes through the provider path**, mock guard, budget guard and cost accounting
   included. The cache is a memo in front of the request, never a second way to get a vector.
3. **The hit/miss split is on the record.** The cache's header warns against *"mistaking cached
   vectors for a measurement"*; declaring the split is what keeps that impossible. A fully
   cached run also writes its `embedding_model` through from the cache key, so a free run is
   never a run without provenance.

`--cache` is **opt-in**. Every existing invocation is unchanged, CI included.

---

## 3. What the fresh evidence actually says

```
fixture v2 · evaluator v2 · 123 scored · corpus_fingerprint = LIVE
recall_at_1  0.9912      (reference 1.0)
mrr          0.9956      (reference 1.0)
```

**One case of 123, in `paraphrase_latin`** — causally attributed to GP-04 by the earlier
analysis. It is not a rounding artifact and it is not a fixture problem: it **reproduces on the
current corpus**, three corpus changes after it was first seen.

So `NO_REGRESSION`'s four independent blockers are now two:

| # | blocker | state |
|---|---|---|
| 1 | fixture version | ~~was never real~~ — a v2 evaluation exists |
| 2 | **score** | **LIVE.** 0.9912 < 1.0. Needs a corpus fix or a recorded waiver. |
| 3 | freshness — evaluation | **CLOSED.** The record carries a live fingerprint. |
| 4 | freshness — sweep | **LIVE.** No sweep has been re-run. **Not waivable.** |

**The baseline was not re-pointed**, no epsilon was added, and the failing case was not dropped
— the three temptations the fixture-architecture decision lists under *what must not happen*.

---

## 4. Defect two: two constants called `DEFAULT_FIXTURE`

`audit-gate-evidence.ts` declared its own:

```ts
const DEFAULT_FIXTURE = "data/taxonomy/eval/retrieval-v3.jsonl";   // the audit's
```

`promote-skills.ts` imports the real one from `taxonomy-retrieval-eval.ts`:

```ts
export const DEFAULT_FIXTURE = join(TAXONOMY_DATA_DIR, "eval", "retrieval-v2.jsonl");
```

The audit therefore reported the gate's answer under a fixture **the gate does not use**, and
that is where the published claim *"`EVAL_COVERED` PASS — 0 of 96 uncovered"* came from.

**Measured both ways, with the default resolved rather than restated:**

```
data/taxonomy/eval/retrieval-v2.jsonl   cases 127   promotable NOT covered  41   <- THE DEFAULT
data/taxonomy/eval/retrieval-v3.jsonl   cases 168   promotable NOT covered   0
```

> **`EVAL_COVERED` is green only when `--fixture` is given explicitly.** With no argument,
> `db:promote:skills` blocks **41 of the 96**.

And the activation plan's own `PROMOTE` command did not name it:

```diff
- pnpm db:promote:skills --batch <dir> --sweep <fresh> --eval <fresh> --apply …
+ pnpm db:promote:skills --batch <dir> --fixture data/taxonomy/eval/retrieval-v3.jsonl \
+     --sweep <fresh> --eval <fresh> --apply …
```

Fixed in three places at once — the audit imports the constant, the documented command names
the fixture, and a test asserts the audit declares no fixture default of its own.

---

## 5. Verified end to end against the real gate

```
pnpm db:promote:skills --batch <phase9d> --sweep <2026-08-21> --eval <fresh>

  corpus fingerprint  = {skill_alias_rows: 336, …}
  evidence freshness  = STALE (NOT WAIVABLE)        <- the SWEEP, not the evaluation
  regression verdict  = BLOCK — R@1 0.9912 (-0.0088), MRR 0.9956 (-0.0044)
  candidates 96 · eligible 0
  blocking = {EVAL_COVERED: 41, NO_REGRESSION: 96, RESOLVABLE_ABOVE_FLOOR: 34}
```

The verdict reaching the **score** comparison is the proof that the freshness check passed on
the evaluation record. Before this change it stopped one step earlier, every time.

---

## 6. What remains, precisely

| what | who | cost |
|---|---|---|
| a fingerprinted **floor sweep** | operator | **₹0.0035** — only fixture v3's 41 added queries are uncached |
| the surviving **one-case regression** | owner: corpus fix, or a recorded waiver | ₹0 |
| `RESOLVABLE_ABOVE_FLOOR` — 28 below-floor skills | owner: ratify corpus aliases (TAX-0 gate d) | ₹0 |
| `RESOLVABLE_ABOVE_FLOOR` — 6 unmeasured | answered by the same sweep | ₹0 extra |

**The floor is not to be lowered and the baseline is not to be re-pointed.** Both remain
prohibited, and the 28 are a corpus problem by construction: the skill is *found*, and not
confidently.

---

## What was NOT done

- **No sweep was run.** It needs ~₹0.0035 of provider calls, which is not authorised here.
- **No waiver was applied.** `--waive NO_REGRESSION` exists and is legitimate; using it would be
  an agent deciding a reviewed judgement belongs to a human. It also could not help: staleness
  is explicitly not waivable, and the sweep is still stale.
- **The `NO_REGRESSION` semantics decision was not taken.** Options A–D remain open. What
  changed is that the decision can now be made against measured facts rather than an
  expectation — including the fact that a strict v2 evaluation is available for free.

```
GATE_ACCEPTED · IS_PROVISIONAL · ACTIVE_EDGE · FULLY_EMBEDDED    PASS — 96/96
MATCH_VOCABULARY                                                 PASS — 0 of 96 missing
EVAL_COVERED                                                     PASS only with --fixture retrieval-v3 (default blocks 41)
RESOLVABLE_ABOVE_FLOOR                                           FAIL — 34 of 96
NO_REGRESSION                                                    FAIL — 2 blockers left, was 4
PROMOTION CANDIDATES                                             96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED · NOTHING ACTIVATED.**

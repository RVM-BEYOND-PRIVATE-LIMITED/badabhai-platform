# Activation readiness — the twelve-point checklist, after the corpus writes

> **2026-08-26 UTC. Four production writes performed under explicit owner authorisation, all
> through existing two-signal ops guards. 13 rows. AI spend ₹0.0116.**
> **NOTHING PROMOTED. NOTHING ACTIVATED. `SKILL_CANONICALIZE_ENABLED` NOT READ, NOT CHANGED,
> STILL FALSE BY DEFAULT.**

---

## 0. The gates, before and after

| gate | before | after |
|---|---|---|
| `GATE_ACCEPTED` · `IS_PROVISIONAL` · `ACTIVE_EDGE` · `FULLY_EMBEDDED` | PASS 96/96 | **PASS 96/96** |
| `MATCH_VOCABULARY` | PASS 0 missing | **PASS 0 missing** |
| `EVAL_COVERED` | blocked 41 under the default fixture | **PASS 0/96** with `--fixture retrieval-v3` |
| `NO_REGRESSION` | **FAIL** — 4 independent blockers | **PASS** — R@1 1 / MRR 1, freshness `current` |
| `RESOLVABLE_ABOVE_FLOOR` | FAIL 34/96 | **FAIL 34/96** — floor held at 0.75 by ruling |
| **eligible for promotion** | **0 of 96** | **62 of 96** |

`promote-skills --plan`, fresh evidence:

```
evidence freshness  = current
regression verdict  = PASS — R@1 1 / MRR 1 meets the reference (1 / 1)
candidates 96 · eligible 62 · blocked 34
blocking criteria   = {"RESOLVABLE_ABOVE_FLOOR": 34}
```

---

## 1. The four production writes, each with its plan and its verification

| # | write | planned | applied | guard |
|---|---|---:|---:|---|
| 1 | GP-04 alias — `skill_coolant_management ← "coolant level"` | 1 row | **1** | `seed:domain-skills` + flag |
| 2 | embed that alias | 1 row | **1** | `embed:skills` + flag |
| 3 | de-elect the 8 ratified duplicates | 8 rows | **8** | `decollide:aliases` + flag |
| 4 | deprecate the 3 approved skills | 3 rows | **3** | `seed:deprecations` + flag |
| | **total** | **13** | **13** | |

Every one used `--i-am-authorised-to-write-to-production` **and**
`OPS_ALLOW_PRODUCTION=<script>`. No guard was bypassed, no new writer was created, and the exact
mutation count was computed and reported before each apply.

> The seeder's own plan line said *"532 row change(s) planned"* — that is its upsert count, not
> its mutation count, because every write carries a `WHERE` that fires only on difference. The
> real number was computed by diffing the corpus against live rows first: **1**. It wrote 1.

---

## 2. The twelve-point checklist

### 1 ▸ Promoted rows verified — **N/A, NOTHING PROMOTED**
`promote-skills` is fail-closed per batch and 34 candidates fail `RESOLVABLE_ABOVE_FLOOR`, so it
refuses. See §3.

### 2 ▸ Aliases verified — **GREEN**
```
skill_coolant_management: "coolant level" [en]  embedded  gemini-embedding-001   <- new
                          "coolant top up" [en] embedded
                          "कूलेंट भरना"   [hi] embedded
8 de-elected rows: embedding NULL = 8/8, text KEPT = 8/8      (nothing deleted, CLAUDE.md §10)
corpus: 337 alias rows, 329 embedded, 1 embedding model
```

### 3 ▸ Deprecations verified — **GREEN**
```
skill_cad_interpretation      deprecated -> skill_drawing_reading
skill_dimensional_inspection  deprecated -> skill_quality_control
skill_gdt_reading             deprecated -> skill_drawing_reading
skill_boring                  UNTOUCHED — excluded by allow-list, unrequestable (D-7A hold)
```

### 4 ▸ No orphan skills — **GREEN**
0 of 111 provisional attribute skills lack an embedded alias. A full sweep for alias texts with
no live embedded holder returns **7**, every one attributable:

| text | holder | why dark |
|---|---|---|
| `chassis assembly`, `चेसिस जोड़ना` | `skill_chassis_fitting` | deprecated **2026-08-20**, predates this cycle |
| `plug gauge check`, `गेज से जांच` | `skill_go_no_go_gauge_checking` | deprecated **2026-08-20**, predates this cycle |
| `dimensional inspection`, `inspection`, `quality check` | `skill_dimensional_inspection` | deprecated today — **exactly the 3 the seeder's plan predicted** |

Nothing unexpected went dark.

### 5 ▸ No cross-decision orphan — **GREEN**
The defect D-7C-1a existed to prevent. All 8 phrases touched by the elections survive on
`skill_drawing_reading`, active and embedded:

```
blueprint reading · drawing reading · GD&T · geometric dimensioning and tolerancing
CAD · drawing padhna · read engineering drawings · technical drawing
                                              phrases surviving = 8, orphaned = 0
```

`drawing padhna` is one of the 22 vernacular aliases ratified 2026-07-16; it survives.

### 6 ▸ No regression — **GREEN**
`R@1 1.0 / MRR 1.0` on fixture v2, evaluator v2, against the unchanged `1.0/1.0` reference.
**The baseline was not re-pointed, no epsilon was added, no failing case was dropped, and no
waiver was used.** The single prior regression, GP-04, was fixed by one evidenced alias rather
than by moving anything.

### 7 ▸ Floor sweep fresh — **GREEN**
`EXP-P9-REGRESSION-FRESH/floor-sweep-2026-08-26T13_18_14.220Z.json` — fixture v3, 164 decisions,
0 errors, corpus fingerprint equal to live.

### 8 ▸ Evaluation fresh — **GREEN**
`EXP-P9-REGRESSION-FRESH/eval-…-2026-08-26T13_15_06.410Z.json` — fingerprint equal to live;
`promote-skills` reports `evidence freshness = current`.

### 9 ▸ Provenance valid — **GREEN**
One embedding model across all 329 embedded rows. 0 proven-mock vectors. 0 unstamped rows. Every
committed artifact carries the `evidence-provenance` header. The evaluation record declares its
cache split (`127 hits / 0 paid`) so a free run cannot be mistaken for a paid one.

### 10 ▸ Production smoke test plan — **READY, NOT RUN**
To be run **after** the flag is enabled, not before:
1. `POST /skills/canonicalize` with a phrase whose expected id is known and scores ≥ 0.75 in the
   fresh sweep; assert `status: matched` and the exact `skill_id`.
2. `POST /skills/canonicalize` with a below-floor phrase; assert `status: unresolved` and a new
   `unresolved_phrase` row.
3. `pnpm db:audit:live-population` — `worker_skill` must begin to fill; it is **0** today.
4. `pnpm db:verify:path-b-parity` — the digest must match the value recorded post-promotion.
5. Langfuse: `skill_canonicalization` traces appear with `real_call=true`.

### 11 ▸ Rollback plan — **READY**
| write | rollback | reversible? |
|---|---|---|
| GP-04 alias | remove from `skills.jsonl`; `UPDATE skill_alias SET embedding=NULL WHERE id='d2162001-…'` | yes — row and text are kept |
| de-elections | delete the entry from `decollided-aliases.json`, re-run `db:embed:skills` | yes — id and text never deleted |
| deprecations | `UPDATE skill SET status='active', replaced_by=NULL` for the three | yes — status flip, nothing deleted |
| promotion (when it happens) | `db:promote:skills --revert <report> --apply` | yes — built in |
| the flag | set the secret back, one deploy cycle | **partial** — rows already written are NOT unwritten |

### 12 ▸ Monitoring plan — **DEFINED**
- `unresolved_phrase` growth rate by scope — the canonicalizer's miss rate in production.
- `worker_skill` / `job_posting_skill` row counts — currently 0; non-zero is the first proof
  activation did anything.
- `ai.cost_recorded` events tagged `skill_embedding` — canonicalization is one embed per phrase.
- The three §5a ceilings, re-measured post-promotion: **a ceiling above its pre-promotion value
  is a reason to stop, not to continue carefully.**
- Langfuse `skill_canonicalization` traces: `skill_canonicalize_disabled` vs a real result
  distinguishes a flag problem from a vocabulary problem — the two return the same body.

---

## 3. The one thing standing between here and promotion

**62 of 96 candidates now pass every gate. `promote-skills` promotes 0 of them**, because it is
fail-closed for the whole batch:

> *"Promotion is all-or-nothing for a batch: promoting the passing subset would leave the corpus
> half live, with no single description of what is retrievable."*

The 34 that block it all fail one criterion, `RESOLVABLE_ABOVE_FLOOR`, and the owner has ruled
that the floor stays at 0.75 and those resolutions remain unresolved. That ruling is recorded and
the 34 are enumerated with their gaps in
[`corpus-improvement-candidates-2026-08-26.md`](./corpus-improvement-candidates-2026-08-26.md).

**Three ways forward. Each is a product call, and none was taken here.**

| | route | effect |
|---|---|---|
| **A** | `--waive RESOLVABLE_ABOVE_FLOOR` | promotes all 96 and records the waiver. The 34 become `active` but stay unassignable — exactly the state the ruling describes. Costs nothing. **It is a gate override.** |
| **B** | re-scope the batch to the 62 | promotes only what passes. Changes what "a batch" means, and the 34 need a home. |
| **C** | corpus work first | 7 of the 34 are within 0.03 of the floor; GP-04 moved 0.0555 on one alias. Cleanest, slowest, needs ratified aliases. |

The standing instruction is *"if and only if every promotion gate is GREEN, execute
`db:promote:skills`"*. `RESOLVABLE_ABOVE_FLOOR` is not green, so promotion was not executed.

---

## 4. Activation prerequisites — where each stands

| # | prerequisite | state |
|---|---|---|
| 1 | corpus writes applied | **DONE** — 13 rows, verified |
| 2 | fresh fingerprinted evidence | **DONE** — both records, ₹0 evaluation |
| 3 | `NO_REGRESSION` green | **DONE** |
| 4 | `EVAL_COVERED` green | **DONE** with the explicit fixture |
| 5 | `RESOLVABLE_ABOVE_FLOOR` green | **NO** — 34 blocked, floor held by ruling |
| 6 | promotion executed | **NO** — blocked by 5 via the fail-closed batch rule |
| 7 | post-promotion observation | not reached |
| 8 | effective flag value read on the box | **NOT DONE** — needs shell access to the running container |
| 9 | flag enabled | **NO, and correctly so** |

**Activation remains impossible, and no gate was weakened to make it look otherwise.**

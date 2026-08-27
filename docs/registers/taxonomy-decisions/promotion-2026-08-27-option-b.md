# The promotion — 62 promoted, 34 held, nothing waived

**Owner ruling PROMOTION-SCOPE option B, 2026-08-27 · applied the same day · one production write, 62 rows**
**AI spend this phase: ₹0 (both post-promotion measurements ran `--offline` and could not spend)**
**`SKILL_CANONICALIZE_ENABLED` NOT changed. Canonicalization is NOT active.**

---

## 1. The ruling, and what it required of the code

> *"Re-scope the current promotion batch from 96 skills to the 62 skills that PASS
> RESOLVABLE_ABOVE_FLOOR. The remaining 34 must NOT be waived, deleted, or promoted. Keep them
> explicitly recorded as HOLD / IMPROVEMENT QUEUE with their measured failure reasons."*

`promote-skills` refused any subset, and its refusal said why:

> *"promoting the passing subset would leave the corpus half live, with no single description
> of what is retrievable"*

The objection is not to promoting a subset. It is to promoting a subset that **nothing
describes**. So the implementation is a description, not an exemption:
[`packages/db/data/taxonomy/held-skills.json`](../../../packages/db/data/taxonomy/held-skills.json)
— 34 entries, each naming the criterion it fails, the score that was measured, the gap to the
floor, and the ruling that authorised the exclusion.

**A hold is a selection. A waiver is a judgement about a failure.** The difference is not
cosmetic:

| | `--waive RESOLVABLE_ABOVE_FLOOR` (option A) | the hold register (option B, taken) |
|---|---|---|
| the 34 | promoted, `active` | **not promoted, still `provisional`** |
| retrievable? | yes — live and unassignable | **no** |
| the verdict | recorded as waived | **recorded as FAILING** |
| the floor | untouched | **untouched** |

All 34 verdicts are in the audit report with `eligible: false` and
`blocking: ["RESOLVABLE_ABOVE_FLOOR"]`, and **zero criteria are marked waived anywhere in the
run.**

---

## 2. Three properties that stop the register becoming a silencer

The obvious failure mode of any exclusion list is that it grows into a way of making
inconvenient failures disappear. Each of these is enforced in
[`promotion-holds.ts`](../../../packages/db/src/promotion-holds.ts), not left to review, and
each has tests.

**1 ▸ A hold authorises exactly ONE criterion.** An entry names the criterion it covers. A
skill held for a below-floor score that later loses its embeddings is `UNAUTHORISED` — the hold
does not reach the new failure, and `--apply` refuses. A vocabulary hold can never conceal a
corpus-integrity defect.

**2 ▸ A hold must still be TRUE.** A held skill that now passes everything is `RELEASABLE`, and
`--apply` refuses. The ruling authorised a *measured* 62/34 split; a drifted register no longer
describes the batch. Deleting the entry is both the fix and the intended way a skill leaves the
improvement queue.

**3 ▸ Omission is self-correcting.** A mistyped id cannot over-promote: the real skill stays in
the selected set, fails there, and the unchanged fail-closed rule refuses the whole run. The
register can only cause harm by commission, and commission is bounded by (1) and (2).

Neither `CRITERIA`, the 0.75 floor, `RESOLVABLE_ABOVE_FLOOR`, `NO_REGRESSION`, `EVAL_COVERED`,
the freshness rule, nor the fail-closed branch was modified. Within the selected set the
all-or-nothing rule is exactly as it was.

---

## 3. The preflight, and the mutation count predicted before it ran

```
evidence freshness       = current
regression verdict       = PASS — R@1 1 / MRR 1 meets the reference (1 / 1)
waived criteria          = (none)
candidates (whole batch) = 96
held (ruling, not waived)= 34  {"RESOLVABLE_ABOVE_FLOOR":34}
selected                 = 62
eligible                 = 62
blocked                  = 0
blocking criteria        = {}
```

Every one of the seven criteria passes **62/62** over the selected set, with **no criterion
waived on any candidate**. The match-vocabulary tripwire passes (5 MATCHED, 91
INTENTIONALLY_UNMATCHED, 0 MISSING_DECISION, 0 INVALID_TARGET). The hold register reconciles
clean: 0 releasable, 0 unauthorised, 0 unknown ids.

**Predicted mutation, read from production before applying: 62 rows.** All 62 selected ids were
`provisional`; all 34 held ids were `provisional`; the two sets do not intersect.

---

## 4. Applied, and verified against production

```
[promote:skills] promoted 62 / 62 to active
  audit report -> docs/registers/skill-promotions/promotion-2026-08-27T05_23_00.862Z.json
```

Guarded by `--i-am-authorised-to-write-to-production` **and**
`OPS_ALLOW_PRODUCTION=promote:skills`. No guard bypassed, no new writer created.

| `skill.status` | before | after | Δ |
|---|---:|---:|---:|
| active | 49 | **111** | +62 |
| provisional | 111 | **49** | −62 |
| deprecated | 5 | 5 | 0 |

- All **62** selected ids read `active`. **0** skipped by the optimistic-concurrency guard.
- All **34** held ids read `provisional` — verified by id, not by subtraction.
- Reversible: `db:promote:skills --revert <report> --apply`.

---

## 5. Post-promotion verification — both measurements provably free

Promotion widened the retrieval surface by 62 skills. The risk that creates is specific: a
newly-active skill outranking a correct one, i.e. a false assignment that did not exist
yesterday. Both runs used the new `--offline` flag, which makes a cache miss **throw** rather
than call the provider — so "this cost nothing" is checkable before the run, not estimated after
it.

### 5.1 No regression — the baseline instrument, post-promotion

`eval-taxonomy-retrieval-v1-v2-e2-2026-08-27T05_38_27.036Z.json`

```
R@1 1.0000   R@3 1.0000   R@5 1.0000   MRR 1.0000
123 queries · 0 failures · 127 query embeds, ALL cached · ₹0
corpus_fingerprint.counts.skills_active = 111   <- proves it describes the POST-promotion corpus
```

Same fixture v2, same evaluator v2, same unchanged 1.0/1.0 reference. **Promotion cost nothing
in ranking quality.**

### 5.2 No false assignment — the first production-equivalent floor sweep

`floor-sweep-2026-08-27T05_44_05.767Z.json`, `skill_statuses = ["active"]`.

This measurement **was not possible before today.** Every candidate was `provisional`, so an
active-only sweep would have retrieved almost nothing; the pre-promotion evidence sweep had to
pass `--include-provisional` and said so in its own notes. It is now a statement about what
production would actually return.

```
threshold   TP    FP    FN    TN   precision   recall   assigned
    0.75    99     0     7    17     100.0%    93.4%     80.5%   <- CURRENT FLOOR
```

- **Zero false positives at the floor**, and none at 0.70 either.
- The highest-scoring wrong answer in the whole sweep is **0.6953** (`PX-07 →
  skill_mechanical_assembly`), so the floor's margin over the best wrong answer **widened from
  0.0289 to 0.0547** when 62 skills went live.
- **The promotion did create new wrong answers, and the floor refuses every one of them.** Nine
  of the seventeen false positives are top-1 hits on a skill that only became retrievable
  today — `skill_stone_joint_pointing`, `skill_refrigerant_charging`,
  `skill_wheel_alignment_and_balancing` and six more. Their highest score is **0.6355**, so all
  nine return `unresolved` in production. Stating it the other way round would have been
  comfortable and misleading: widening the surface widened the wrong answers too, and what
  makes that safe is the floor, not the absence of competition.
- The other side of the same measurement: **all 106 correct top-1 answers in the decided set are
  skills promoted today**, 99 of them above the floor. Before this write, an active-only sweep
  had almost nothing to retrieve.

**COVERAGE, STATED PLAINLY: 123 of 164 cases decided; 41 UNMEASURED.** Those 41 are exactly the
`TP-01…TP-41` trainer cases added in fixture v3, whose query vectors are not in the local cache
— the flush defect fixed on 2026-08-26 meant the two runs that paid for them never wrote them to
disk. `--offline` declined to buy them again and the runner now names every one. Every figure
above is over the 123 decided cases only.

> **GAP CLOSED, 2026-08-27**, on owner authorisation. The 41 vectors were bought for **₹0.00563**
> — not the ₹0.0035 estimated here, which came from a stale figure in the programme graph; the
> measured rate is ₹0.000137 per query. The sweep now decides **164 of 164, 0 unmeasured, 0
> errors**, and the numbers moved as more evidence was added: at 0.75 the production-equivalent
> sweep reads **TP 109, FP 0, FN 11, TN 44 — precision still 100 %**, with the highest wrong
> answer anywhere at **0.7245**.
>
> **The fuller evidence changed nothing about the 62/34 split.** 0 of the 34 held skills clear
> the floor; 0 of the 30 scored ones moved by more than 0.0001; the same 4 remain unmeasured;
> all 62 promoted still clear it. See
> [`activation-procedure-2026-08-27.md`](./activation-procedure-2026-08-27.md) §3.

### 5.3 What the held 34 cost, made visible

A production-equivalent run of the *evaluation* now refuses, and its refusal is worth reading:

```
cases unreachable in DB = 7
e.g. PA-12:jd_nco_7112_0100/skill_wall_plumb_and_level_checking,
     GP-02:jd_isco_7127/skill_refrigerant_leak_detection,
     GP-05:jd_nco_7223_6002/skill_first_piece_approval
```

Every one of those names a **held** skill. The evaluator is refusing to blame the model for a
promotion gap, which is correct. Twenty-seven fixture-v3 cases sit in the same position.

**This is the cost of option B, and it is the right cost:** those cases are unpassable because
the skills they expect are genuinely not retrievable, which is exactly what the ruling decided.
They become passable again as the improvement queue empties — one skill at a time, by evidenced
alias, on the GP-04 precedent.

---

## 6. The improvement queue is live, not archival

[`corpus-improvement-candidates-2026-08-26.md`](./corpus-improvement-candidates-2026-08-26.md)
lists all 34 with their measured gaps. What changed today is that it now has a mechanism behind
it: **delete an entry from `held-skills.json` and the skill re-enters the batch automatically.**
Nothing else has to be remembered, and nothing can be released by accident — a released skill
that still fails is caught by the unchanged fail-closed rule.

Seven of the 34 are within 0.03 of the floor. GP-04 moved a skill 0.0555 with one alias, for
₹0.000038.

# TD-01 domain-edge condition (R19) — proposed decision, NOT authorized

> **Status: PROPOSED. Nothing has been applied.** No `job_domain_skill` row has been created,
> moved or deleted. This document exists so the decision is made against measurement rather
> than against a description, and so it is made by the person who owns it.
>
> Evidence: [`phase-9-path-a-replay-*.json`](../../../packages/db/data/taxonomy/replay/),
> produced by `pnpm db:replay:path-a` (read-only, zero provider calls) on **2026-08-18**.

---

## 1. The condition

TD-01 merged `skill_gdt_reading` (8 edges) and `skill_cad_interpretation` (6 edges) into a new
skill, `skill_drawing_reading`. As applied on `main`:

| | status | `job_domain_skill` edges | aliases |
|---|---|---:|---:|
| `skill_gdt_reading` | `deprecated` | 8 | 4 |
| `skill_cad_interpretation` | `deprecated` | 6 | 3 |
| **`skill_drawing_reading`** | **`active`** | **0** | **8** |

`canonicalAliasRows` gates on **both** `s.status = 'active'` **and** a join to
`job_domain_skill`. TD-01 fails a different gate on each side simultaneously: the predecessors
hold every edge but are no longer active; the successor is active but holds no edge. Neither
side is reachable.

This was not a defect anyone introduced carelessly — the Phase-8 register explicitly declined
to re-point the edges, on the grounds that re-pointing is a `job_domain_skill` decision it was
not authorized to make. That reasoning stands. What the register did not record is the
*consequence*, which is what this document supplies.

## 2. What the replay measured

Drawing-reading aliases reachable through Path A, across the 28 job domains the fixture covers:

| corpus variant | reachable aliases | domains |
|---|---:|---:|
| `pre_merge` | **56** | 12 |
| **`as_applied`** (`main` today) | **0** | **0** |
| `edges_repointed` (counterfactual) | **96** | 12 |

Total erasure, and the counterfactual restores *more* than existed before — the merged skill
carries 8 aliases where the split pair contributed 4 and 3 to different domain sets.

Effect on retrieval quality, same 116 cases, k=5:

| | R@1 | MRR | notes |
|---|---|---|---|
| `pre_merge` | **0.9912** | **0.9956** | |
| `as_applied` | **0.9912** | **0.9956** | **bit-identical** |
| `edges_repointed` | **0.9912** | **0.9956** | **bit-identical** |

Under production `active`-only semantics the merges did move 10 cases (8 top-1 changes, 2 —
`DC-10`, `DC-17` — went from 4 candidates to 0 and became unresolved), but R@1 is 0 in every
variant there because every expected skill is an unpromoted provisional. That comparison cannot
separate a good change from a bad one.

## 3. Why "no measurable impact" is NOT the finding

**Zero fixture cases name `skill_drawing_reading`, `skill_gdt_reading` or
`skill_cad_interpretation`** — verified by grep over both `retrieval-v1.jsonl` and
`retrieval-v2.jsonl`. Recall cannot move when a surface disappears if no case ever queried that
surface.

So the two measurements are not in tension, and only one of them is competent:

- The **reachability** measurement is direct. It says the surface is gone.
- The **recall** measurement is blind by construction. It says nothing at all.

Reading "R@1 unchanged" as "the merge was safe" would be inferring safety from an instrument
that cannot see the thing being judged. That is the same error shape as treating
`text_norm IS NOT NULL` as evidence of election, or `verify CLEAN` as canonicalization
readiness. It is recorded here so it is not repeated.

**Verdict: the condition is material by direct measurement and unadjudicated by the
evaluation set.** It therefore goes to authorization rather than being closed as a known
limitation.

## 4. The three options

| | Action | Cost | Risk | Reversible? |
|---|---|---|---|---|
| **A** | **Re-point the 14 edges** to `skill_drawing_reading` | 14 `job_domain_skill` rows; corpus-file change to `domain-skills.jsonl` | Widens the drawing-reading surface to 96 alias-slots across 12 domains — *more* than pre-merge. Un-measured, because the fixture has no case that would catch a false positive | Yes — delete/restore the 14 rows by id set |
| **B** | **Leave as-is**, record as a known limitation | None | The vocabulary of a live, active skill is permanently unreachable through the target retrieval path. Any worker who says "GD&T", "blueprint reading" or "drawing padhna" resolves to nothing under Path A | n/a |
| **C** | **Fixture first**, then decide | Trainer time: reviewed cases for drawing-reading in ≥2 of the 12 domains | Delays the decision; costs nothing irreversible | n/a |

**Recommendation: C, then A.** A is very likely correct — an active skill with no reachable
surface is not a state anyone designed — but option A's own risk (a widened generic surface,
`cad` among it) is exactly what the current fixture cannot measure. Buying the instrument
before making the change costs one trainer pass and removes the guesswork from both.

If C is refused on time grounds, **A is preferable to B**, with the widening explicitly
recorded as un-measured and GP-04 re-checked after.

## 5. What is NOT proposed here

- No change to the TD-01 merge itself. It is ratified and applied.
- No alias addition, removal or demotion.
- No election, no retrieval-predicate change, no embedding.
- No change to `skill_dimensional_inspection`'s 2 or `skill_boring`'s 1 orphaned edge. They
  belong to the same class but their successors (`skill_quality_control`, `skill_turning`) are
  active and already edged, so nothing is unreachable. They are noted, not bundled.
- Both production flags stay `false`.

## 6. Authorization required

**Owner: whoever owns `job_domain_skill` edges** (Backend Platform). This is the same boundary
the Phase-8 register drew and declined to cross; it has not moved.

Not sufficient: the TD-01 ratification. That decision merged two skills. It did not authorize
re-homing their domain edges, and the register says so in its own words.

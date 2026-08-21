# TD-01 domain-edge condition (R19) — RATIFIED AND APPLIED

> **Status: RATIFIED 2026-08-18 and APPLIED to the taxonomy corpus.** The 14 edges have been
> re-pointed onto `skill_drawing_reading` in `packages/db/data/taxonomy/domain-skills.jsonl`.
> **Corpus files only** — no database was seeded, nothing was embedded, both production flags
> remain `false`.
>
> Evidence: [`data/taxonomy/replay/`](../../../packages/db/data/taxonomy/replay/), produced by
> `pnpm db:replay:path-a` (read-only, zero provider calls) on **2026-08-18**.
>
> **What decided it.** The reachability collapse alone was arguably survivable. What was not
> was *what replaced it*: under production semantics, **88 of 96 probes returned a confident,
> unrelated skill** — measuring instruments, gas cutting, mechanical assembly, turning, CMM,
> bench fitting — rather than nothing. Silent misclassification, not a retrieval gap. Option C
> (fixture-first) was then found to be **impossible**: `validateEvalFixture` refuses any case
> whose expected skill has no edge (`EXPECTED_SKILL_NOT_IN_SCOPE ... unpassable by
> construction`), so the fixture could not host coverage for the merged skill until the very
> edges under debate existed. That removed the only argument for waiting.
>
> ## Application record
>
> | | |
> |---|---|
> | Manifest | [`phase-9-td01-edge-repoint-manifest.json`](../../../packages/db/data/taxonomy/replay/phase-9-td01-edge-repoint-manifest.json) |
> | Source edges | 14 (8 `skill_gdt_reading` + 6 `skill_cad_interpretation`) |
> | Re-pointed | 12 |
> | Absorbed as duplicates | 2 — `jd_nco_7223_6003`, `jd_nco_7224_0102` were wired to **both** predecessors |
> | Corpus edge total | 238 → **236** (required 146 → 145, preferred 92 → 91) |
> | sha256 | `9c28d7db…3876` → `14ecef97…37ee` |
>
> **The absorbed pair is the only judgement in the change.** A naive rewrite would have emitted
> the same `(job_domain_id, skill_id)` twice, which `validateTaxonomyCorpus` rejects as
> `EDGE_DUPLICATE`. Survivors were chosen by strength — `required` beats `preferred`, then
> relevance, then confidence — and `skill_gdt_reading`'s edge won both times. Taking the weaker
> would have silently downgraded `jd_nco_7224_0102` from **required to preferred**, a real
> change to what the platform asks of a worker hidden inside a mechanical re-point.
>
> **Verification.** Post-repair `as_applied` matches the pre-repair `edges_repointed`
> counterfactual on **all ten metrics exactly** (cases, resolved, unresolved, scored, hits,
> R@1, MRR, mean candidates, false positives, false negatives) — the change did what was
> predicted and nothing else. Probe 0/96 → **96/96** reachable and top-1. `db:verify:taxonomy`
> PASS, `db:verify:aliases` CLEAN on both production tables, db 1005/1005, taxonomy 46/46,
> match-engine 209/209. `skill_drawing_reading` remains `active`; both predecessors remain
> `deprecated` with their `replacedBy` intact and their own alias arrays untouched (SG-5).
>
> **Evidence boundary, restated because it is easy to lose.** The 96 probes are tautological
> alias probes — diagnostic evidence only, never ground-truth recall. The supportable claim is:
> *the zero-edge state caused systematic silent misclassification for the TD-01 alias surface,
> and the re-point restores correct candidate reachability and top-1 selection across the
> diagnostic probe set.* It is **not** a claim about production recall.
>
> Still open: the 11-case provider gap (§5), fixture coverage for drawing-reading (now
> possible, since the edges exist), and every production activation gate.

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

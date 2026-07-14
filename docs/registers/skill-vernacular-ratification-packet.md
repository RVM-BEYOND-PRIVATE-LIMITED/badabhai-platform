# Skill vernacular aliases — RVM ratification packet (ADR-0030 / TAX-5, gate d)

**Status: PROPOSED — awaiting the RVM domain owner.** Nothing below reaches the live
vocabulary until ratified: every entry ships `ratified: false` in
[`packages/taxonomy/src/wedge-aliases.ts`](../../packages/taxonomy/src/wedge-aliases.ts),
the seed inserts only ratified rows, and the taxonomy test
(`wedge-aliases.test.ts`) asserts the unratified state — **ratifying = flipping the
flag(s) + updating that assertion in the same diff**, so the human decision is visible
in review.

## Why (measured, 2026-07-14, real vectors)

The standards-only corpus cannot hear the shop floor: on the labeled wedge set
(`apps/ai-service/tests/wedge_eval/scores_2026_07_14.json`, `gemini-embedding-001`@768):

| Vernacular phrase | Best the corpus can do | Score | Verdict at floor 0.75 |
|---|---|---|---|
| `kharad` | `skill_boring` (**wrong**) | 0.575 | UNRESOLVED ✅ (floor refused a wrong match) |
| `kharad ka kaam` | `skill_turning` (right) | 0.603 | UNRESOLVED (too weak to trust) |
| `chhilai` | `skill_milling` (right) | 0.528 | UNRESOLVED |
| `ghisai` | `skill_grinding_ops` (right) | 0.535 | UNRESOLVED |
| `chudi katna` | `skill_tapping_threading` (right) | 0.586 | UNRESOLVED |

A ratified alias makes each an exact-space match (≈1.0) — the difference between a
worker's `kharad` landing on their profile vs. sitting in the growth queue.

## The proposals (22 — see wedge-aliases.ts for the authoritative list)

| Vernacular (hi) | → skill_id | Note for the reviewer |
|---|---|---|
| kharad · kharad ka kaam | `skill_turning` | Owner's exemplar (kharad = lathe). |
| chhilai | `skill_milling` | **Q-A:** owner glossed "milling/finishing" — if the floor sense is finishing, remap to `skill_deburring`. |
| chhed karna · drilling ka kaam | `skill_drilling` | |
| chudi katna | `skill_tapping_threading` | chudi = thread; variant "chudi katai". |
| ghisai · ghisai ka kaam | `skill_grinding_ops` | |
| finishing ka kaam | `skill_deburring` | |
| job setting · setting karna | `skill_fixture_setup` | |
| program banana | `skill_cnc_programming` | Sweep shows the corpus confuses this with `skill_program_editing` (0.666) — the alias settles it. |
| program sudharna | `skill_program_editing` | |
| drawing padhna | `skill_gdt_reading` | **Q-B:** could map to `skill_cad_interpretation`; chose shop-floor drawing reading. |
| naap tol · micrometer se naapna | `skill_measuring_instruments` | |
| quality check karna | `skill_quality_control` | |
| welding ka kaam | `skill_welder_occupation` | |
| gas se katna | `skill_gas_cutting` | |
| chadar ka kaam | `skill_sheet_metal` | |
| fitting ka kaam | `skill_bench_fitting` | |
| machine ki marammat | `skill_machine_maintenance` | |

## How to ratify (the whole loop)

1. Review the table; answer **Q-A** (chhilai) and **Q-B** (drawing padhna); strike any
   term that's wrong for your shops — mappings are yours, not the model's (SG-3/TAX-0).
2. Flip `ratified: true` on the approved entries in `wedge-aliases.ts` **and** update
   the `ships FULLY UNRATIFIED` assertion in `wedge-aliases.test.ts` (same PR).
3. `pnpm build && NODE_ENV=staging pnpm db:seed:skills` — only ratified rows insert.
4. `pnpm db:embed:skills` — real vectors for the new rows (SG-4 env per the
   [SR-1 runbook](../ai/skill-embedding-staging-runbook.md)).
5. Re-run the sweep (`embed_wedge.py` → `score-wedge.ts`), commit the new snapshot, and
   update `test_vernacular_tier_is_below_floor_until_wedge_aliases_land` — the
   vernacular tier should now ASSIGN at the floor.

**Rollback:** delete the alias rows (ids are deterministic) or flip `ratified` back —
the immutable skill ids are untouched either way (SG-5).

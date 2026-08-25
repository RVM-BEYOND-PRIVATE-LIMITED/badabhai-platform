# Skill vernacular aliases — RVM ratification packet (ADR-0030 / TAX-5, gate d)

**Status: RATIFIED — 2026-07-16, by the RVM domain owner (all 22 entries; none struck).**
Rulings: **Q-A** chhilai → `skill_deburring` (owner confirms the shop-floor sense is
finishing; joins "finishing ka kaam" as a second alias on the same skill — expected).
**Q-B** drawing padhna → `skill_cad_interpretation` (owner confirms the phrase implies
reading CAD/digital models on their floors). Every entry now carries `ratified: true` in
[`packages/taxonomy/src/wedge-aliases.ts`](../../packages/taxonomy/src/wedge-aliases.ts)
and `wedge-aliases.test.ts` pins the exact ratified set (22/22 + both remaps) — the human
decision is visible in that diff. ~~**Seed / embed / re-sweep remain PENDING the SR-1
staging env (ADR-0030 gates (b)/(e))**: ratified aliases seed with NULL embeddings, so
the committed sweep recall stays **0.350** until the real-embed + re-sweep run.~~
**← STRUCK 2026-08-24: false since 2026-07-16.** Seed and embed ran on the ratification
date. **Only the re-sweep is pending**, so 0.350 is the pre-alias number and must not be
quoted as the shipped state. This sentence was quoted as corroboration by two downstream
documents and produced a wrong finding in both.

> ### Status correction — 2026-08-24
>
> **Steps 3 and 4 below were marked PENDING and had in fact already run.** Measured read-only
> against production on 2026-08-24: all 22 aliases exist in `skill_alias`, all 22 embedded,
> 21 created `2026-07-16` (the ratification date) and `drawing padhna` on `2026-08-20`.
>
> Only **step 5, the re-sweep, is genuinely outstanding**. The historical body below is left
> unedited apart from the three step lines; the measurement it records is still accurate for
> 2026-07-14.
>
> This stale PENDING marker caused a downstream error: `d6-vernacular-gap-plan.md` §2B
> concluded the aliases were "never shipped" and the owner-decision packet carried that as its
> highest-value recommendation. Both are corrected.

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

## The entries (22, RATIFIED 2026-07-16 — see wedge-aliases.ts for the authoritative list)

| Vernacular (hi) | → skill_id | Note for the reviewer |
|---|---|---|
| kharad · kharad ka kaam | `skill_turning` | Owner's exemplar (kharad = lathe). |
| chhilai | `skill_deburring` | **Q-A ANSWERED (2026-07-16):** owner confirms the shop-floor sense = finishing → REMAPPED `skill_milling` ➜ `skill_deburring`; joins "finishing ka kaam" on the same skill (expected/valid). |
| chhed karna · drilling ka kaam | `skill_drilling` | |
| chudi katna | `skill_tapping_threading` | chudi = thread; variant "chudi katai". |
| ghisai · ghisai ka kaam | `skill_grinding_ops` | |
| finishing ka kaam | `skill_deburring` | |
| job setting · setting karna | `skill_fixture_setup` | |
| program banana | `skill_cnc_programming` | Sweep shows the corpus confuses this with `skill_program_editing` (0.666) — the alias settles it. |
| program sudharna | `skill_program_editing` | |
| drawing padhna | `skill_cad_interpretation` | **Q-B ANSWERED (2026-07-16):** owner confirms the phrase implies reading CAD/digital models → REMAPPED `skill_gdt_reading` ➜ `skill_cad_interpretation`. |
| naap tol · micrometer se naapna | `skill_measuring_instruments` | |
| quality check karna | `skill_quality_control` | |
| welding ka kaam | `skill_welder_occupation` | |
| gas se katna | `skill_gas_cutting` | |
| chadar ka kaam | `skill_sheet_metal` | |
| fitting ka kaam | `skill_bench_fitting` | |
| machine ki marammat | `skill_machine_maintenance` | |

## How to ratify (the whole loop)

1. **DONE 2026-07-16** — table reviewed; **Q-A** and **Q-B** answered (rulings above);
   no term struck — mappings are yours, not the model's (SG-3/TAX-0).
2. **DONE 2026-07-16** (RATIFY-1) — all 22 entries flipped to `ratified: true` in
   `wedge-aliases.ts`; `wedge-aliases.test.ts` now pins the exact ratified set in the
   same diff.
3. **DONE 2026-07-16** — `db:seed:skills`; all 22 ratified rows are in production
   `skill_alias`. *(Status corrected 2026-08-24; this line read PENDING for five weeks
   after the step had run.)*
4. **DONE 2026-07-16** — `db:embed:skills`; all 22 carry a `gemini-embedding-001` vector.
   *(Same correction. `drawing padhna` is dated 2026-08-20 — the Q-B remap.)*
5. **STILL PENDING** — re-run the sweep (`embed_wedge.py` → `score-wedge.ts`), commit the
   new snapshot, and update `test_vernacular_tier_is_below_floor_until_wedge_aliases_land`.
   **This is the only step that genuinely has not run:** the sole scores file on disk is
   `scores_2026_07_14.json`, which predates the ratification, **so the committed recall of
   0.350 is still the pre-alias number and must not be quoted as the shipped state.**
   Needs a paid embedding run for the wedge phrases (~₹0.003).

**Rollback:** delete the alias rows (ids are deterministic) or flip `ratified` back —
the immutable skill ids are untouched either way (SG-5).

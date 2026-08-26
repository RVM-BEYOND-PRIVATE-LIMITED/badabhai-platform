# Q1 — disposition triage for the 96 promotable skills

**Prepared against main `fe0bd566` · 2026-08-26 · repository-only, plus one zero-spend read**
**Production mutation: NONE · AI spend: ₹0 · nothing applied, no `mskill_*` invented**

Artifacts: [`q1-disposition-triage.json`](./q1-disposition-triage.json) ·
[`q1-neighbour-evidence.json`](./q1-neighbour-evidence.json)
Reproduce: `pnpm db:audit:q1-triage` (repository-only) · `pnpm db:audit:q1-neighbours` (read-only DB)

> **NON-BINDING.** Every row is a proposal. `ATTRIBUTE_TO_MATCH_SKILLS`, `MATCH_SKILLS` and
> `SKILL_CORPUS` are byte-identical, nothing was promoted, and the Q1 tripwire still fails
> 96/96 — asserted by test. Individual skill→`mskill_*` mappings remain yours to review.

---

## 1. The headline

```
promotable skills            96
MATCHED (proposed)            5
INTENTIONALLY_UNMATCHED      75
REVIEW                       16
```

**Only 5 of 96 are genuine mapping candidates.** That is not conservatism for its own sake —
it is what the vocabulary supports.

**8 of 13 trade families have no `mskill_*` at all**, covering **62 of the 96 skills**:
electrical (11), warehouse (11), masonry (9), HVAC (10), automotive service (7), battery (6),
assembly (4), sheet metal (4). There is no electrician, no mason, no warehouse operative, no
AC technician and no auto mechanic in the match vocabulary. Those 62 are not a backlog of
mappings waiting to be made; they are **a finding about the vocabulary's coverage**.

---

## 2. Why similarity did not author this pack

`db:audit:q1-neighbours` measured, for all 96, the nearest already-triaged skill and what it
maps to, using stored vectors (zero spend). **For 61 of 96 that neighbour is mapped** — so an
automated triage would have proposed **61 mappings**. This pack proposes **5**.

The gap is the whole finding. The strongest evidence points at the worst answers:

| skill | nearest mapped neighbour | score | why it is wrong |
|---|---|---:|---|
| `ducting_installation` | `pipe_fitting` → **plumber** | **0.827** | a duct carries air; a pipe carries water |
| `visual_defect_identification` | `dimensional_inspection` → **QI** | **0.803** | every operator does this — the micrometer pattern |
| `inspection_report_recording` | `dimensional_inspection` → **QI** | 0.801 | writing a measurement down is not making one |
| `split_unit_installation` | `bench_fitting` → **fitter** | 0.752 | an AC installer is not a fitter |
| `plastering` | `plumber_occupation` → **plumber** | 0.749 | a plasterer is not a plumber |
| `pipe_bending` | `pipe_fitting` → **plumber** | 0.752 | conduit electricians bend pipe too |

**The four highest cross-family scores in the entire set are all wrong mappings.** Any
similarity threshold low enough to be useful fires on these first.

---

## 3. The rule applied

A skill earns MATCHED only if it is **trade-defining** — doing it is evidence of *practising*
that trade, not of working near it. Two traps are rejected by construction:

- **The attribute trap.** Near-universal operations (torque wrench, cutting-tool selection,
  visual defect spotting) are done by everyone in the shop. Mapping one reaches the whole shop
  for a specialist's vacancy. This is the bridge's own doctrine — *"THE EMPTY ONES ARE THE
  POINT"*.
- **The adjacency trap.** A skill in a family with no match skill must not be routed to the
  nearest family that has one. **A missing vocabulary entry is not a reason to borrow someone
  else's.** A test asserts no unrepresented-family skill is MATCHED.

---

## 4. Group 1 — proposed MATCHED (5)

| skill | → | confidence | why it is trade-defining | risk |
|---|---|---|---|---|
| `sanitary_fixture_installation` | `mskill_plumber` | **high** | WCs, basins, taps, traps — the defining work of the trade | its *nearest* neighbour is actually `bench_fitting`→fitter @ 0.690; the disposition ignores the ranking |
| `non_destructive_testing_of_castings` | `mskill_quality_inspector` | **high** | dye-penetrant/ultrasonic/radiography is a certified inspection discipline held as a job | — |
| `leak_repair_in_water_lines` | `mskill_plumber` | medium | "water lines" is what keeps it in plumbing rather than generic pipework | if it covers industrial process lines in practice, demote to REVIEW |
| `drain_cleaning_and_unclogging` | `mskill_plumber` | medium | **consistency only**: `skill_drainage_systems → mskill_plumber` is already ratified and this is the same work | you named "drainage systems → plumber" as a false-friend pattern. If that mapping is reconsidered, this moves with it |
| `hardness_testing` | `mskill_quality_inspector` | medium | lab measurement on a dedicated instrument, consistent with `skill_cmm → QI` | heat-treatment operators test their own output |

**Largest product/safety impact if wrong:** the three plumber mappings. `mskill_plumber` is a
live match skill with real vacancies, and plumbing phrases collide with electrical conduit and
HVAC work throughout this batch.

---

## 5. Group 2 — proposed INTENTIONALLY_UNMATCHED (75)

Closed with no candidate. Two reasons, both structural:

**(a) No match skill exists for the trade — 62 skills.** Electrical, warehouse, masonry, HVAC,
automotive service, battery, assembly, sheet metal. Every one of these has a mapped neighbour
that is a *different trade*, which is exactly why they are closed rather than mapped.

**(b) The skill is an attribute — 13 skills.** Torque wrench operation, fastener tightening,
cutting-tool selection, coolant management, lubrication, barcode scanning, weld spatter
cleaning, consumable changeover, rejection tagging, **visual defect identification**, chemical
handling safety, electrical safety/lockout, customer site handover.

### The false friends worth reading

- **`wall_plumb_and_level_checking`** — the purest lexical collision in the pack: *"plumb"* the
  verb (vertical) against *"plumber"* the trade (pipes). Neighbour → `mskill_plumber` @ 0.663.
- **`ducting_installation`** — highest score in the set (0.827) and wrong.
- **`visual_defect_identification`** — the micrometer pattern at 0.803. Mapping it would reach
  the entire shop floor for every Quality Inspector vacancy.
- **`brazing_of_copper_lines`** → `arc_welding` @ 0.646. Brazing is not a fusion process; the
  three welder skills are MIG, TIG and arc.
- **`material_handling_equipment_operation`** → `milling` → **VMC operator** @ 0.694. A pallet
  truck is not a machining centre; only the word "operation" is shared.
- **`forklift_operation`** — a licensed competency with real hiring value and **no match skill
  to carry it**. The clearest single argument that the vocabulary is too narrow for this corpus.
  Recorded, not filled.

---

## 6. Group 3 — REVIEW (16)

Grouped by the question each one actually asks.

**Is it the setter/operator, or QC?** — `first_piece_approval`,
`sub_assembly_quality_checking`, `surface_finish_inspection`, `inspection_report_recording`,
`weld_bead_inspection`.
`surface_finish_inspection` is the sharpest: its two nearest neighbours are `deburring`
(deliberately **unmapped**, 0.746) and `dimensional_inspection` (**mapped** to QI, 0.745) — one
point apart, pointing opposite ways.

**Is maintenance work "fitting"?** — `bearing_replacement`, `pump_and_valve_repair`,
`shaft_and_coupling_alignment`.
All three are ITI-Fitter work in Indian industry. Against: `skill_machine_maintenance` is
already deliberately unmapped, so mapping these makes the narrower skill confer what the
broader one withholds. `shaft_and_coupling_alignment` is the strongest of the three.

**Plumbing, or generic pipework?** — `pipe_bending`, `pipe_support_and_clamping`,
`pressure_testing_of_pipelines`, `solvent_cement_jointing`.
Each is shared with conduit electricians and HVAC. `conduit_bending_and_laying` sits in this
same batch doing the same motion for cables.

**Two trades in one skill** — `structural_fit_up_and_tacking` (fitter + arc welder). Fit-up is
fitting; tacking is welding. Mapping to both reaches two vacancy pools from one skill — and
tacking evidences no specific process.

**Inside the launch wedge — highest impact** — `lathe_chuck_mounting`. The only promotable
skill in the CNC wedge's own domain. `skill_turning → mskill_cnc_turner` is precedent, but all
three of its nearest neighbours (tapping, fixture setup, drilling) are deliberately unmapped
attributes.

**The D-7B adjacency** — `body_panel_alignment`. You ratified `skill_chassis_fitting →
mskill_fitter`; this is the neighbouring auto-body operation. Whether the ratification reaches
it is a product call. **A test pins this as the only unrepresented-family skill even asked
about**, so the ratification cannot silently spread across automotive work.

**One process-specific welding case** — `electrode_selection` → `mskill_arc_welder`. Unlike the
rest of the welding family it *does* imply a process. Against: selecting a consumable is still
an attribute.

---

## 7. What was not done

- No mapping applied · no `mskill_*` invented · `MATCH_SKILLS` still 18 · bridge still 49 keys
- No skill promoted; `eligible = 0`; Q1 tripwire still **FAIL 96/96**
- Floor unchanged at **0.75** · `NO_REGRESSION` unchanged · `SKILL_CANONICALIZE_ENABLED`
  untouched (false) · D-7A `skill_boring` still held · D-7B ratification not extended ·
  D-7C unchanged · §5a untouched
- No database mapping relation introduced — the bridge stays curated and code-based

## 8. Gates

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL — 96/96      unchanged
EVAL_COVERED              FAIL — 41/96      unchanged
MATCH_VOCABULARY          FAIL — 96/96      unchanged (this pack proposes; it does not apply)
PROMOTION CANDIDATES      96, eligible 0    unchanged
```

**PROMOTION BLOCKED.**

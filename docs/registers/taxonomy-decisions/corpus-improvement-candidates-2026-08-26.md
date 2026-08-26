# The 34 — corpus-improvement candidates, recorded per owner ruling RESOLVABLE-28

> **Owner ruling, 2026-08-26:** *"KEEP the 0.75 floor unchanged. Correct-but-below-floor
> resolutions remain unresolved. Do not lower the threshold. Record these as future
> corpus-improvement candidates."* This is that record.
>
> Measured against the **post-write corpus** — after the GP-04 alias, the 8 de-elections and the
> 3 deprecations. Sweep: `EXP-P9-REGRESSION-FRESH/floor-sweep-2026-08-26T13_18_14.220Z.json`,
> fixture `retrieval-v3`, statuses `active+provisional`, 164 decisions, 0 errors.

---

## Why these are a corpus problem and not a threshold problem

The fresh sweep settles it at the current floor:

```
threshold   TP    FP    FN    TN   precision   recall   assigned
    0.75   109     0    41    14     100.0%    72.7%     66.5%   <- CURRENT FLOOR
```

**Precision is 100 % at 0.75.** The highest-scoring wrong answer in the whole sweep is
**0.7211** (`TP-27 → skill_control_panel_wiring`), which the floor already refuses. Every
threshold below 0.75 admits that wrong answer before it admits most of the skills below —
`0.60` buys 99.3 % recall at 96.8 % precision, and 5 false positives.

So lowering the floor does not "unlock" these skills cleanly; it trades a perfect precision
record for a handful of confident misassignments. The ruling to leave it at 0.75 is what the
measurement supports, and this list is the alternative route: **give each skill vocabulary a
worker would actually use.**

The GP-04 fix in this same run is the worked example — one evidenced alias, `coolant level`,
moved `skill_coolant_management` from *behind a wrong answer* to *first*, and cost ₹0.000038.

---

## A. CORRECT_BUT_BELOW_FLOOR — 30

The skill **is** found and ranked first; it is simply not found confidently. Each is one or two
aliases away. Sorted by how far they have to travel.

| best correct | skill | gap to 0.75 |
|---:|---|---:|
| 0.7466 | `skill_thermostat_and_control_wiring` | 0.0034 |
| 0.7443 | `skill_sub_assembly_quality_checking` | 0.0057 |
| 0.7379 | `skill_motor_connection_and_starter_wiring` | 0.0121 |
| 0.7356 | `skill_issue_and_requisition_control` | 0.0144 |
| 0.7302 | `skill_distortion_control_in_weldments` | 0.0198 |
| 0.7250 | `skill_split_unit_installation` | 0.0250 |
| 0.7245 | `skill_customer_site_handover` | 0.0255 |
| 0.7202 | `skill_vibration_and_noise_fault_diagnosis` | 0.0298 |
| 0.7186 | `skill_site_material_stacking` | 0.0314 |
| 0.7184 | `skill_sanitary_fixture_installation` | 0.0316 |
| 0.7181 | `skill_vehicle_diagnostic_scanning` | 0.0319 |
| 0.7148 | `skill_cutting_tool_selection` | 0.0352 |
| 0.7051 | `skill_wall_plumb_and_level_checking` | 0.0449 |
| 0.7043 | `skill_assembly_line_sequencing` | 0.0457 |
| 0.6951 | `skill_clutch_and_gearbox_repair` | 0.0549 |
| 0.6933 | `skill_first_piece_approval` | 0.0567 |
| 0.6874 | `skill_battery_cell_stacking` | 0.0626 |
| 0.6860 | `skill_refrigerant_leak_detection` | 0.0640 |
| 0.6836 | `skill_house_wiring_installation` | 0.0664 |
| 0.6827 | `skill_body_panel_alignment` | 0.0673 |
| 0.6797 | `skill_battery_terminal_crimping` | 0.0703 |
| 0.6762 | `skill_sheet_metal_marking_and_layout` | 0.0738 |
| 0.6666 | `skill_belt_and_chain_drive_alignment` | 0.0834 |
| 0.6639 | `skill_non_destructive_testing_of_castings` | 0.0861 |
| 0.6515 | `skill_electrical_safety_and_lockout` | 0.0985 |
| 0.6419 | `skill_electrical_fault_finding` | 0.1081 |
| 0.6399 | `skill_concrete_curing` | 0.1101 |
| 0.6395 | `skill_insulation_resistance_testing` | 0.1105 |
| 0.6244 | `skill_welding_machine_consumable_changeover` | 0.1256 |
| 0.5986 | `skill_wiring_harness_routing` | 0.1514 |

**The top seven are within 0.03 of the floor.** On the GP-04 precedent — a single well-chosen
alias moved a skill 0.0555 — those are plausibly one alias each.

## B. NO_CORRECT_CASE_IN_SWEEP — 4

The sweep never produced a correct resolution for these at all. **Down from 6**: the fresh v3
sweep answered two of the previous six, which is why category A grew from 28 to 30.

- `skill_battery_capacity_checking`
- `skill_switchgear_installation`
- `skill_indoor_unit_servicing_and_cleaning`
- `skill_pump_and_valve_repair`

These need a reviewed evaluation case before anything can be concluded about them; they are not
known-bad, they are unmeasured.

## C. ONLY_EVER_A_WRONG_ANSWER — 0

**The worst category is empty**, as it was before the writes. Not one promotable skill appears
solely as somebody else's wrong answer.

---

## What this list is not

- **Not a work order.** Each entry needs a phrase a worker would actually say, chosen by a
  person and ratified under TAX-0 gate (d). **No alias is proposed here.** The one alias added in
  this cycle was chosen from the failing query's own wording, measured against three
  alternatives, and applied as the smallest change that cleared a measured regression.
- **Not an argument for moving the floor.** The floor stays at 0.75; the ruling and the
  measurement agree.
- **Not a promotion blocker list in perpetuity.** It is the blocker list *today*: 34 of 96
  candidates fail `RESOLVABLE_ABOVE_FLOOR`, and `db:promote:skills` is fail-closed per batch, so
  the 62 that pass cannot be promoted while these 34 do not.

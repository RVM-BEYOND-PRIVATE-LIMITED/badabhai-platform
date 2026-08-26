/**
 * Q1 — the proposed disposition for each of the 96 promotable skills. **NON-BINDING.**
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 * The Q1 tripwire (`match-vocabulary-coverage.ts`) refuses to promote a skill that has neither
 * a mapping nor an explicit "stays an attribute". 96 of 96 currently have neither. This file
 * is the TRIAGE PACK for that backlog: one proposed disposition per skill, with the reason.
 *
 * It changes nothing. `ATTRIBUTE_TO_MATCH_SKILLS` is untouched, no `mskill_*` is invented, and
 * a test asserts both. The owner ratifies; a later task applies exactly what is ratified.
 *
 * ===========================================================================
 * WHY SIMILARITY DID NOT AUTHOR THIS
 * ===========================================================================
 * `audit-q1-neighbour-evidence.ts` measured, for every one of the 96, the nearest
 * already-triaged skill and what it maps to. **For 61 of 96 that neighbour is mapped** — so a
 * similarity-driven triage would have proposed 61 mappings. Its most confident ones are wrong:
 *
 *     ducting_installation        -> pipe_fitting @ 0.827 -> mskill_plumber      HVAC, not plumbing
 *     visual_defect_identification-> dimensional_inspection @ 0.803 -> mskill_quality_inspector
 *                                                                      every operator does this
 *     plastering                  -> plumber_occupation @ 0.749 -> mskill_plumber
 *                                                                      "plumb" != "plumber"
 *     split_unit_installation     -> bench_fitting @ 0.752 -> mskill_fitter      AC tech, not fitter
 *
 * This pack proposes **5**. The gap between 61 and 5 is the whole point: the question is not
 * "what is this close to?" but "does a worker with this skill belong in that vacancy?"
 *
 * ===========================================================================
 * THE GOVERNING RULE
 * ===========================================================================
 * A skill earns MATCHED only if it is TRADE-DEFINING — doing it is evidence of practising that
 * trade, not merely of working near it. Two failure modes are rejected by construction:
 *
 *   THE ATTRIBUTE TRAP  near-universal operations (torque wrench, cutting-tool selection,
 *                       visual defect spotting) are done by everyone in the shop. Mapping one
 *                       reaches the whole shop for a specialist's vacancy. This is the bridge's
 *                       own recorded doctrine — "THE EMPTY ONES ARE THE POINT".
 *   THE ADJACENCY TRAP  a skill in a family with NO match skill (electrical, masonry, HVAC,
 *                       warehouse, automotive service, battery) must not be routed to the
 *                       nearest family that has one. **A missing vocabulary entry is not a
 *                       reason to borrow someone else's.**
 *
 * 8 of the 13 trade families here have no corresponding `mskill_*` at all, covering 63 of the
 * 96 skills. That is a finding
 * about the vocabulary, not a backlog of mappings waiting to be made.
 */
import type { MatchSkillId } from "@badabhai/taxonomy";

export type Disposition = "MATCHED" | "INTENTIONALLY_UNMATCHED" | "REVIEW";
export type Confidence = "high" | "medium" | "low";

/** Trade families, and whether the match vocabulary represents them at all. */
export const FAMILIES = {
  assembly: { label: "Assembly (automotive / general)", represented: false },
  battery: { label: "Battery manufacturing", represented: false },
  "auto-service": { label: "Automotive service & repair", represented: false },
  "machining-support": { label: "Machining support (CNC wedge)", represented: true },
  masonry: { label: "Masonry & civil construction", represented: false },
  electrical: { label: "Electrical installation", represented: false },
  "sheet-metal": { label: "Sheet metal & fabrication", represented: false },
  hvac: { label: "HVAC & refrigeration", represented: false },
  "mech-maintenance": { label: "Mechanical maintenance", represented: true },
  plumbing: { label: "Plumbing & sanitary", represented: true },
  quality: { label: "Quality & inspection", represented: true },
  warehouse: { label: "Warehouse & stores", represented: false },
  "welding-support": { label: "Welding support skills", represented: true },
} as const;

export type FamilyKey = keyof typeof FAMILIES;

export interface TriageRow {
  readonly skillId: string;
  readonly label: string;
  readonly family: FamilyKey;
  /** Best candidate(s) from the EXISTING 18. Empty for INTENTIONALLY_UNMATCHED. */
  readonly candidates: readonly MatchSkillId[];
  readonly disposition: Disposition;
  readonly confidence: Confidence;
  readonly rationale: string;
  /** A specific way this could be mapped wrongly, named so a reviewer can check it. */
  readonly falseFriend?: string;
}

const NO_FAMILY = (what: string): string =>
  `No match skill represents ${what}. The vocabulary's 18 concepts cover CNC machining, ` +
  `welding, fitting, plumbing, carpentry, quality inspection, design and delivery — none ` +
  `of them is this trade, and borrowing the nearest one would place the worker in a vacancy ` +
  `they are not qualified for.`;

const ATTRIBUTE = (what: string): string =>
  `${what} Mapping it would reach every one of them for a specialist's vacancy — the ` +
  `attribute trap the bridge already guards against for micrometers and GD&T.`;

/**
 * All 96, exactly once, in batch order.
 *
 * Ordered as the batch is rather than grouped by disposition, so a reviewer diffing this
 * against `accepted-skills.jsonl` can read them side by side.
 */
export const Q1_TRIAGE: readonly TriageRow[] = [
  // ---- Assembly ----------------------------------------------------------
  {
    skillId: "skill_torque_wrench_operation",
    label: "Torque wrench operation",
    family: "assembly",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Every assembler and fitter uses a torque wrench."),
    falseFriend: "The micrometer pattern: owning and using a hand tool is not a trade.",
  },
  {
    skillId: "skill_wiring_harness_routing",
    label: "Wiring harness routing",
    family: "assembly",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("automotive line assembly"),
    falseFriend:
      "Reads as electrical work, but routing a pre-made harness on a line is assembly, not " +
      "an electrician's trade — and there is no electrician match skill in any case.",
  },
  {
    skillId: "skill_assembly_line_sequencing",
    label: "Assembly line sequencing",
    family: "assembly",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("production sequencing on an assembly line"),
  },
  {
    skillId: "skill_fastener_selection_and_tightening",
    label: "Fastener selection and tightening",
    family: "assembly",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Selecting and tightening fasteners is universal across every mechanical trade."),
  },
  {
    skillId: "skill_sub_assembly_quality_checking",
    label: "Sub-assembly quality checking",
    family: "quality",
    candidates: ["mskill_quality_inspector"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "In-line checking by the assembler who built the sub-assembly, or a QC role? The label " +
      "does not say, and the two readings have opposite consequences.",
    falseFriend:
      "Nearest mapped neighbour is skill_mechanical_assembly -> mskill_fitter @ 0.711, which " +
      "is a third answer again. Similarity cannot settle this one.",
  },

  // ---- Battery manufacturing ---------------------------------------------
  {
    skillId: "skill_battery_cell_stacking",
    label: "Battery cell stacking",
    family: "battery",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("battery cell manufacturing"),
  },
  {
    skillId: "skill_battery_terminal_crimping",
    label: "Battery terminal crimping",
    family: "battery",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("battery pack assembly"),
  },
  {
    skillId: "skill_electrolyte_filling",
    label: "Electrolyte filling",
    family: "battery",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("battery cell manufacturing"),
  },
  {
    skillId: "skill_battery_pack_leak_testing",
    label: "Battery pack leak testing",
    family: "battery",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale:
      "A production test station operated by line staff, not a quality-inspection role. " +
      NO_FAMILY("battery manufacturing"),
    falseFriend:
      "Nearest mapped neighbour is skill_quality_control -> mskill_quality_inspector @ 0.672. " +
      "Performing a test is not holding an inspector's post.",
  },
  {
    skillId: "skill_battery_capacity_checking",
    label: "Battery capacity checking",
    family: "battery",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale: "An end-of-line measurement task. " + NO_FAMILY("battery manufacturing"),
    falseFriend:
      "skill_dimensional_inspection -> mskill_quality_inspector @ 0.702 is the nearest mapped " +
      "neighbour; same objection as leak testing.",
  },
  {
    skillId: "skill_chemical_handling_safety",
    label: "Chemical handling safety",
    family: "battery",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale:
      "A safety competency required alongside a trade, never a trade in itself. No match " +
      "skill should ever be conferred by it.",
  },

  // ---- Automotive service ------------------------------------------------
  {
    skillId: "skill_engine_overhauling",
    label: "Engine overhauling",
    family: "auto-service",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("automotive mechanical repair"),
    falseFriend:
      "mskill_fitter is INDUSTRIAL fitting — machines, pumps, structures. An engine mechanic " +
      "is a different trade with different employers, and the adjacency trap would send them " +
      "to a factory fitter's vacancy.",
  },
  {
    skillId: "skill_brake_system_servicing",
    label: "Brake system servicing",
    family: "auto-service",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("automotive mechanical repair"),
  },
  {
    skillId: "skill_suspension_and_steering_repair",
    label: "Suspension and steering repair",
    family: "auto-service",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("automotive mechanical repair"),
  },
  {
    skillId: "skill_clutch_and_gearbox_repair",
    label: "Clutch and gearbox repair",
    family: "auto-service",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("automotive mechanical repair"),
  },
  {
    skillId: "skill_vehicle_diagnostic_scanning",
    label: "Vehicle diagnostic scanning",
    family: "auto-service",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("automotive diagnostics"),
    falseFriend:
      "Nearest mapped neighbour is skill_quality_control -> mskill_quality_inspector @ 0.647. " +
      "Running a diagnostic scanner on a car has nothing to do with factory QC.",
  },
  {
    skillId: "skill_wheel_alignment_and_balancing",
    label: "Wheel alignment and balancing",
    family: "auto-service",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("automotive service"),
    falseFriend:
      "Nearest mapped neighbour is skill_turning -> mskill_cnc_turner @ 0.647 — a wheel " +
      "alignment technician is not a lathe operator. Pure rotational-vocabulary collision.",
  },
  {
    skillId: "skill_body_panel_alignment",
    label: "Body panel alignment",
    family: "auto-service",
    candidates: ["mskill_fitter"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "THE D-7B ADJACENCY. The owner has ratified skill_chassis_fitting -> mskill_fitter, and " +
      "body panel alignment is the neighbouring auto-body operation. Whether that ratification " +
      "extends to it is a product call about how wide 'Fitter' reaches into vehicle work.",
    falseFriend:
      "Ratifying one automotive route to Fitter could be read as ratifying the family. It " +
      "was ratified for chassis fitting specifically.",
  },

  // ---- Machining support (inside the launch wedge) -----------------------
  {
    skillId: "skill_lathe_chuck_mounting",
    label: "Lathe chuck mounting",
    family: "machining-support",
    candidates: ["mskill_cnc_setter_operator", "mskill_cnc_turner"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "THE HIGHEST-IMPACT QUESTION IN THIS PACK — the only promotable skill inside the launch " +
      "wedge's own domain. Mounting a chuck is a setter's operation on a turning machine. " +
      "skill_turning is already mapped to mskill_cnc_turner, so the precedent exists; but " +
      "chuck mounting is a setup step, not the turning itself.",
    falseFriend:
      "Its three nearest neighbours (tapping, fixture setup, drilling) are ALL deliberately " +
      "unmapped attributes, which argues this is one too.",
  },
  {
    skillId: "skill_cutting_tool_selection",
    label: "Cutting tool selection",
    family: "machining-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Every machinist selects cutting tools."),
  },
  {
    skillId: "skill_coolant_management",
    label: "Coolant management",
    family: "machining-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Every machine operator manages coolant."),
  },
  {
    skillId: "skill_first_piece_approval",
    label: "First piece approval",
    family: "machining-support",
    candidates: ["mskill_quality_inspector", "mskill_cnc_setter_operator"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "First-piece approval is the setter's job in some plants and QC's in others. The two " +
      "candidates are both defensible and lead to different vacancies.",
  },

  // ---- Masonry & civil ---------------------------------------------------
  {
    skillId: "skill_mortar_mixing",
    label: "Mortar mixing",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("masonry and civil construction"),
    falseFriend:
      "Nearest mapped neighbour is skill_grinding_ops -> mskill_cnc_grinding_operator @ 0.646. " +
      "Absurd on its face, and it would have been an automatic mapping.",
  },
  {
    skillId: "skill_stone_dressing",
    label: "Stone dressing",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("stonemasonry"),
    falseFriend:
      "skill_turning -> mskill_cnc_turner @ 0.665 is the nearest mapped neighbour. Dressing " +
      "stone by hand is not CNC turning.",
  },
  {
    skillId: "skill_brick_and_block_laying",
    label: "Brick and block laying",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("bricklaying and masonry"),
    falseFriend:
      "skill_woodworking -> mskill_carpenter @ 0.680. A mason is not a carpenter; they merely " +
      "share a building site.",
  },
  {
    skillId: "skill_wall_plumb_and_level_checking",
    label: "Wall plumb and level checking",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("masonry"),
    falseFriend:
      "A PURE LEXICAL COLLISION, and the clearest one in the pack: 'plumb' the verb (vertical) " +
      "against 'plumber' the trade (pipes). Nearest mapped neighbour is skill_plumber_occupation " +
      "-> mskill_plumber @ 0.663. Checking a wall is vertical has nothing to do with plumbing.",
  },
  {
    skillId: "skill_plastering",
    label: "Plastering",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("plastering"),
    falseFriend:
      "skill_plumber_occupation -> mskill_plumber @ 0.749 — one of the highest scores in the " +
      "whole set, and wrong. A plasterer is not a plumber.",
  },
  {
    skillId: "skill_scaffolding_erection",
    label: "Scaffolding erection",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("scaffolding"),
  },
  {
    skillId: "skill_concrete_curing",
    label: "Concrete curing",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("concrete work"),
  },
  {
    skillId: "skill_stone_joint_pointing",
    label: "Stone joint pointing",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("stonemasonry"),
  },
  {
    skillId: "skill_site_material_stacking",
    label: "Site material stacking",
    family: "masonry",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: "Unskilled site labour. " + NO_FAMILY("construction site labour"),
  },

  // ---- Electrical --------------------------------------------------------
  {
    skillId: "skill_house_wiring_installation",
    label: "House wiring installation",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical installation"),
    falseFriend:
      "THE WHOLE ELECTRICAL FAMILY IS THE ADJACENCY TRAP. There is no electrician match skill, " +
      "and eleven promotable skills sit here. Every one of them has a mapped neighbour that " +
      "is a different trade.",
  },
  {
    skillId: "skill_conduit_bending_and_laying",
    label: "Conduit bending and laying",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical installation"),
    falseFriend:
      "skill_pipe_fitting -> mskill_plumber @ 0.687. Conduit is bent for CABLES, not water. " +
      "This is also why skill_pipe_bending in this same batch is only REVIEW, not MATCHED.",
  },
  {
    skillId: "skill_earthing_and_bonding",
    label: "Earthing and bonding",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical installation"),
    falseFriend: "skill_plumber_occupation -> mskill_plumber @ 0.724. Earthing is electrical safety.",
  },
  {
    skillId: "skill_cable_termination_and_jointing",
    label: "Cable termination and jointing",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical installation"),
    falseFriend: "skill_woodworking -> mskill_carpenter @ 0.677, on the word 'jointing'.",
  },
  {
    skillId: "skill_electrical_fault_finding",
    label: "Electrical fault finding",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical diagnostics"),
    falseFriend: "skill_quality_control -> mskill_quality_inspector @ 0.690, on 'finding faults'.",
  },
  {
    skillId: "skill_distribution_board_assembly",
    label: "Distribution board assembly",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical panel work"),
    falseFriend: "skill_bench_fitting -> mskill_fitter @ 0.681, on 'assembly'.",
  },
  {
    skillId: "skill_insulation_resistance_testing",
    label: "Insulation resistance testing",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical testing"),
  },
  {
    skillId: "skill_motor_connection_and_starter_wiring",
    label: "Motor connection and starter wiring",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical installation"),
    falseFriend: "skill_fitter_occupation -> mskill_fitter @ 0.617.",
  },
  {
    skillId: "skill_electrical_safety_and_lockout",
    label: "Electrical safety and lockout",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale:
      "A safety competency, not a trade — the same objection as chemical handling safety.",
    falseFriend:
      "skill_machinist_occupation -> mskill_cnc_operator_general @ 0.625. A lockout procedure " +
      "does not make someone a CNC operator.",
  },
  {
    skillId: "skill_control_panel_wiring",
    label: "Control panel wiring",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical panel work"),
  },
  {
    skillId: "skill_switchgear_installation",
    label: "Switchgear installation",
    family: "electrical",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("electrical installation"),
    falseFriend: "skill_bench_fitting -> mskill_fitter @ 0.732 — a high score, and still wrong.",
  },

  // ---- Sheet metal & fabrication -----------------------------------------
  {
    skillId: "skill_sheet_metal_marking_and_layout",
    label: "Sheet metal marking and layout",
    family: "sheet-metal",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale:
      "Follows an existing decision: skill_sheet_metal is already deliberately unmapped in the " +
      "bridge, on the recorded ground that sheet-metal work makes nobody a welder.",
  },
  {
    skillId: "skill_shearing_machine_operation",
    label: "Shearing machine operation",
    family: "sheet-metal",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("sheet-metal machine operation"),
    falseFriend: "skill_turning -> mskill_cnc_turner @ 0.697. A shear is not a lathe.",
  },
  {
    skillId: "skill_press_brake_bending",
    label: "Press brake bending",
    family: "sheet-metal",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("press-brake operation"),
    falseFriend:
      "skill_turning -> mskill_cnc_turner @ 0.725. Both are 'machines that shape metal', and " +
      "that is the entire basis of the similarity.",
  },
  {
    skillId: "skill_punching_machine_operation",
    label: "Punching machine operation",
    family: "sheet-metal",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("punching-machine operation"),
    falseFriend: "skill_turning -> mskill_cnc_turner @ 0.713.",
  },
  {
    skillId: "skill_structural_fit_up_and_tacking",
    label: "Structural fit-up and tacking",
    family: "welding-support",
    candidates: ["mskill_fitter", "mskill_arc_welder"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "The skill names TWO trades: fit-up is fitting, tacking is welding. Its neighbours split " +
      "the same way (bench_fitting @ 0.706 -> Fitter, welder_occupation @ 0.692 -> MIG welder). " +
      "Mapping to both would reach two different vacancy pools from one skill.",
    falseFriend:
      "The welding half tacks — it does not lay a finished bead, so no specific process " +
      "(MIG/TIG/arc) is actually evidenced.",
  },

  // ---- HVAC & refrigeration ----------------------------------------------
  {
    skillId: "skill_refrigerant_charging",
    label: "Refrigerant charging",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("HVAC and refrigeration"),
  },
  {
    skillId: "skill_brazing_of_copper_lines",
    label: "Brazing of copper lines",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale:
      "Brazing joins with a filler below the parent metal's melting point. The three welder " +
      "match skills are MIG, TIG and arc — all fusion processes. Brazing evidences none of them.",
    falseFriend:
      "skill_arc_welding -> mskill_arc_welder @ 0.646. 'Joining metal with heat' is the only " +
      "thing they share, and an HVAC brazer sent to an arc-welding vacancy would fail it.",
  },
  {
    skillId: "skill_vacuum_pump_evacuation",
    label: "Vacuum pump evacuation",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("HVAC service"),
  },
  {
    skillId: "skill_compressor_replacement",
    label: "Compressor replacement",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale: NO_FAMILY("HVAC service"),
    falseFriend:
      "skill_pipe_fitting -> mskill_plumber @ 0.724 and skill_bench_fitting -> mskill_fitter " +
      "@ 0.720 — two different wrong trades, nearly tied.",
  },
  {
    skillId: "skill_refrigerant_leak_detection",
    label: "Refrigerant leak detection",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("HVAC service"),
    falseFriend: "skill_drainage_systems -> mskill_plumber @ 0.623, on the word 'leak'.",
  },
  {
    skillId: "skill_thermostat_and_control_wiring",
    label: "Thermostat and control wiring",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("HVAC controls"),
  },
  {
    skillId: "skill_ducting_installation",
    label: "Ducting installation",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("HVAC ductwork"),
    falseFriend:
      "THE STRONGEST FALSE FRIEND IN THE ENTIRE PACK: skill_pipe_fitting -> mskill_plumber " +
      "@ 0.827, the highest cross-family score of all 96. A duct carries air; a pipe carries " +
      "water. Any similarity threshold low enough to be useful would fire on this first.",
  },
  {
    skillId: "skill_split_unit_installation",
    label: "Split unit installation",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("air-conditioning installation"),
    falseFriend: "skill_bench_fitting -> mskill_fitter @ 0.752. An AC installer is not a fitter.",
  },
  {
    skillId: "skill_indoor_unit_servicing_and_cleaning",
    label: "Indoor unit servicing and cleaning",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("air-conditioning service"),
  },
  {
    skillId: "skill_customer_site_handover",
    label: "Customer site handover",
    family: "hvac",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale:
      "A service-delivery behaviour shared by every field trade. Not a trade, and not evidence " +
      "of one.",
  },

  // ---- Mechanical maintenance --------------------------------------------
  {
    skillId: "skill_bearing_replacement",
    label: "Bearing replacement",
    family: "mech-maintenance",
    candidates: ["mskill_fitter"],
    disposition: "REVIEW",
    confidence: "medium",
    rationale:
      "The strongest genuine case in this family. Bearing replacement is core maintenance-fitter " +
      "work, and 'Fitter' is an ITI trade in India that explicitly covers it.",
    falseFriend:
      "Cuts against an existing decision: skill_machine_maintenance is deliberately unmapped in " +
      "the bridge. Mapping this would make the narrower skill confer what the broader one " +
      "withholds, which needs an explicit reason.",
  },
  {
    skillId: "skill_belt_and_chain_drive_alignment",
    label: "Belt and chain drive alignment",
    family: "mech-maintenance",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale:
      "Follows the skill_machine_maintenance precedent: routine plant upkeep is an attribute " +
      "of many roles rather than evidence of the fitting trade.",
  },
  {
    skillId: "skill_lubrication_schedule_execution",
    label: "Lubrication schedule execution",
    family: "mech-maintenance",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Greasing to a schedule is done by operators and helpers, not only fitters."),
  },
  {
    skillId: "skill_vibration_and_noise_fault_diagnosis",
    label: "Vibration and noise fault diagnosis",
    family: "mech-maintenance",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale:
      "Condition monitoring is its own discipline with no match skill; the nearest represented " +
      "trade is not it.",
    falseFriend: "skill_quality_control -> mskill_quality_inspector @ 0.662, on 'diagnosis'.",
  },
  {
    skillId: "skill_pump_and_valve_repair",
    label: "Pump and valve repair",
    family: "mech-maintenance",
    candidates: ["mskill_fitter"],
    disposition: "REVIEW",
    confidence: "medium",
    rationale:
      "Same question as bearing replacement, with an extra complication: pumps and valves are " +
      "also plumbing hardware, so the wrong answer here reaches TWO wrong pools.",
    falseFriend:
      "skill_plumber_occupation -> mskill_plumber @ 0.651 is its third neighbour. Industrial " +
      "pump overhaul is not domestic plumbing.",
  },
  {
    skillId: "skill_shaft_and_coupling_alignment",
    label: "Shaft and coupling alignment",
    family: "mech-maintenance",
    candidates: ["mskill_fitter"],
    disposition: "REVIEW",
    confidence: "medium",
    rationale:
      "The most fitter-defining skill in this family — precision alignment with dial gauges or " +
      "laser is skilled fitting work, not general maintenance. If any of the three maintenance " +
      "REVIEW cases becomes MATCHED, this is the strongest candidate.",
  },

  // ---- Plumbing ----------------------------------------------------------
  {
    skillId: "skill_sanitary_fixture_installation",
    label: "Sanitary fixture installation",
    family: "plumbing",
    candidates: ["mskill_plumber"],
    disposition: "MATCHED",
    confidence: "high",
    rationale:
      "THE CLEAREST MATCH IN THE PACK. Installing WCs, washbasins, taps and traps is the " +
      "defining work of the plumbing trade — a worker who does it IS a plumber, and an " +
      "employer posting for a plumber wants exactly this.",
    falseFriend:
      "Worth noting the evidence disagrees: its NEAREST neighbour is skill_bench_fitting -> " +
      "mskill_fitter @ 0.690, ahead of skill_plumber_occupation @ 0.687. The disposition comes " +
      "from what the trade IS, not from the ranking.",
  },
  {
    skillId: "skill_leak_repair_in_water_lines",
    label: "Leak repair in water lines",
    family: "plumbing",
    candidates: ["mskill_plumber"],
    disposition: "MATCHED",
    confidence: "medium",
    rationale:
      "'Water lines' is the qualifier that keeps this in the plumbing trade rather than in " +
      "generic pipework. Repairing domestic and building water lines is plumber's work.",
    falseFriend:
      "Process-piping and HVAC technicians also repair leaks. If the phrase in practice covers " +
      "industrial process lines, this should fall back to REVIEW.",
  },
  {
    skillId: "skill_solvent_cement_jointing",
    label: "Solvent cement jointing",
    family: "plumbing",
    candidates: ["mskill_plumber"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "PVC solvent jointing is everyday plumbing, but it is a TECHNIQUE rather than a trade, " +
      "and the identical technique joins electrical conduit.",
    falseFriend:
      "skill_conduit_bending_and_laying is in this same batch. A worker who solvent-joints " +
      "conduit is an electrician's helper, not a plumber.",
  },
  {
    skillId: "skill_drain_cleaning_and_unclogging",
    label: "Drain cleaning and unclogging",
    family: "plumbing",
    candidates: ["mskill_plumber"],
    disposition: "MATCHED",
    confidence: "medium",
    rationale:
      "Proposed on the strength of an EXISTING RATIFIED DECISION rather than independently: " +
      "skill_drainage_systems -> mskill_plumber is already in the bridge, and this is the same " +
      "work. Consistency argues for the same answer.",
    falseFriend:
      "The owner named 'drainage systems -> plumber' as a false-friend pattern to watch. " +
      "Facilities and housekeeping staff also unclog drains. If the existing mapping is itself " +
      "reconsidered, this one must move with it.",
  },
  {
    skillId: "skill_pipe_bending",
    label: "Pipe bending",
    family: "plumbing",
    candidates: ["mskill_plumber"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "Plumbers bend pipe — and so do conduit electricians, HVAC technicians and fabricators. " +
      "The skill names no medium and no trade.",
    falseFriend:
      "skill_pipe_fitting -> mskill_plumber @ 0.752 would make this an automatic mapping, and " +
      "skill_conduit_bending_and_laying sits in the same batch doing the same motion for cables.",
  },
  {
    skillId: "skill_pressure_testing_of_pipelines",
    label: "Pressure testing of pipelines",
    family: "plumbing",
    candidates: ["mskill_plumber"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "Water, gas, process and HVAC lines are all pressure-tested, by four different trades.",
  },
  {
    skillId: "skill_pipe_support_and_clamping",
    label: "Pipe support and clamping",
    family: "plumbing",
    candidates: ["mskill_plumber"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "Generic pipework support, shared with HVAC, sprinkler and mechanical trades. Closer to " +
      "an attribute than a trade.",
    falseFriend: "skill_pipe_fitting -> mskill_plumber @ 0.739 would map it automatically.",
  },

  // ---- Quality & inspection ----------------------------------------------
  {
    skillId: "skill_visual_defect_identification",
    label: "Visual defect identification",
    family: "quality",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Every operator on every line identifies visual defects; it is the first thing anyone is taught."),
    falseFriend:
      "THE MICROMETER PATTERN AT ITS MOST DANGEROUS: skill_dimensional_inspection -> " +
      "mskill_quality_inspector @ 0.803, the second-highest score in the whole set. Mapping it " +
      "would reach the entire shop floor for every Quality Inspector vacancy.",
  },
  {
    skillId: "skill_inspection_report_recording",
    label: "Inspection report recording",
    family: "quality",
    candidates: ["mskill_quality_inspector"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "Recording results is clerical and shared with operators. Flagged for an explicit answer " +
      "only because its score would otherwise carry it.",
    falseFriend:
      "skill_dimensional_inspection @ 0.801 — third-highest in the set. Writing down a " +
      "measurement is not making one.",
  },
  {
    skillId: "skill_rejection_tagging_and_segregation",
    label: "Rejection tagging and segregation",
    family: "quality",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Tagging and moving rejects is line discipline every operator follows."),
  },
  {
    skillId: "skill_surface_finish_inspection",
    label: "Surface finish inspection",
    family: "quality",
    candidates: ["mskill_quality_inspector"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "A genuine near-tie, and the evidence itself is ambivalent: its two nearest neighbours are " +
      "skill_deburring (deliberately UNMAPPED, 0.746) and skill_dimensional_inspection (MAPPED " +
      "to Quality Inspector, 0.745) — one point apart, pointing opposite ways.",
    falseFriend:
      "A finisher checking their own surface is not an inspector; a metrology lab measuring Ra " +
      "is. The label covers both.",
  },
  {
    skillId: "skill_hardness_testing",
    label: "Hardness testing",
    family: "quality",
    candidates: ["mskill_quality_inspector"],
    disposition: "MATCHED",
    confidence: "medium",
    rationale:
      "Hardness testing is a laboratory/QC measurement performed on a dedicated instrument, " +
      "consistent with the already-ratified skill_cmm -> mskill_quality_inspector.",
    falseFriend:
      "Heat-treatment operators run hardness checks on their own output. The mapping assumes " +
      "the QC reading of the phrase.",
  },
  {
    skillId: "skill_non_destructive_testing_of_castings",
    label: "Non-destructive testing of castings",
    family: "quality",
    candidates: ["mskill_quality_inspector"],
    disposition: "MATCHED",
    confidence: "high",
    rationale:
      "NDT is a certified inspection discipline — dye penetrant, ultrasonic, radiography. A " +
      "worker who performs it holds inspection as their JOB, not as a side duty. The strongest " +
      "quality-family match.",
  },

  // ---- Warehouse & stores ------------------------------------------------
  {
    skillId: "skill_stock_counting",
    label: "Stock counting",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("warehousing and stores"),
    falseFriend:
      "ELEVEN promotable skills sit in this family and the vocabulary has nothing for any of " +
      "them. mskill_delivery_rider is last-mile delivery, not warehouse work.",
  },
  {
    skillId: "skill_inventory_record_keeping",
    label: "Inventory record keeping",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("stores administration"),
  },
  {
    skillId: "skill_goods_receipt_verification",
    label: "Goods receipt verification",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("goods inward"),
    falseFriend:
      "skill_dimensional_inspection -> mskill_quality_inspector @ 0.694. Checking a delivery " +
      "note against cartons is not dimensional metrology.",
  },
  {
    skillId: "skill_bin_location_management",
    label: "Bin location management",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("warehouse layout and storage"),
  },
  {
    skillId: "skill_dispatch_documentation",
    label: "Dispatch documentation",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("dispatch administration"),
  },
  {
    skillId: "skill_material_handling_equipment_operation",
    label: "Material handling equipment operation",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("material-handling equipment"),
    falseFriend:
      "skill_milling -> mskill_vmc_operator @ 0.694. Operating a pallet truck is not operating " +
      "a machining centre; only the word 'operation' is shared.",
  },
  {
    skillId: "skill_pallet_stacking_and_loading",
    label: "Pallet stacking and loading",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("warehouse handling"),
  },
  {
    skillId: "skill_issue_and_requisition_control",
    label: "Issue and requisition control",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("stores control"),
  },
  {
    skillId: "skill_order_picking_and_packing",
    label: "Order picking and packing",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: NO_FAMILY("order fulfilment"),
  },
  {
    skillId: "skill_forklift_operation",
    label: "Forklift operation",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale:
      "A licensed competency with real hiring value and NO match skill to carry it — the " +
      "clearest single argument that the vocabulary is too narrow for this corpus. " +
      NO_FAMILY("materials handling"),
    falseFriend:
      "skill_turning -> mskill_cnc_turner @ 0.609. Creating mskill_forklift_operator is out of " +
      "scope here; the gap is recorded, not filled.",
  },
  {
    skillId: "skill_barcode_scanning",
    label: "Barcode scanning",
    family: "warehouse",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Scanning a barcode is a task, performed across warehousing, retail and production."),
  },

  // ---- Welding support ---------------------------------------------------
  {
    skillId: "skill_gas_torch_flame_setting",
    label: "Gas torch flame setting",
    family: "welding-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale:
      "Oxy-fuel work. The three welder match skills are MIG, TIG and arc; none covers gas, and " +
      "skill_gas_cutting is already deliberately unmapped for exactly this reason.",
  },
  {
    skillId: "skill_oxy_acetylene_cylinder_handling",
    label: "Oxy-acetylene cylinder handling",
    family: "welding-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: "Gas-handling safety, not a welding process. Same reasoning as gas torch flame setting.",
  },
  {
    skillId: "skill_weld_bead_inspection",
    label: "Weld bead inspection",
    family: "welding-support",
    candidates: ["mskill_quality_inspector"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "Welders inspect their own beads as a matter of course; dedicated weld inspectors also " +
      "exist as a role. Which reading the phrase carries decides whether this is an attribute " +
      "of welding or a QC trade.",
  },
  {
    skillId: "skill_welding_joint_preparation",
    label: "Welding joint preparation",
    family: "welding-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale:
      "Edge preparation is shared by welders, fitters and fabricators, and names no process, " +
      "so it evidences no specific welder match skill.",
  },
  {
    skillId: "skill_distortion_control_in_weldments",
    label: "Distortion control in weldments",
    family: "welding-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale:
      "Genuine advanced welding knowledge, but process-agnostic — and the vocabulary has only " +
      "process-specific welders. There is no 'welder, general' to carry it.",
    falseFriend:
      "skill_welder_occupation -> mskill_mig_welder @ 0.704 would map it to MIG SPECIFICALLY, " +
      "which the skill does not evidence at all.",
  },
  {
    skillId: "skill_weld_spatter_cleaning",
    label: "Weld spatter cleaning",
    family: "welding-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Cleaning spatter is post-weld tidying, often done by helpers rather than welders."),
  },
  {
    skillId: "skill_weld_program_parameter_setting",
    label: "Weld program parameter setting",
    family: "welding-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "medium",
    rationale:
      "Robotic or machine-welding setup. No automated-welding match skill exists, and the " +
      "manual welder concepts do not describe this work.",
    falseFriend:
      "skill_tool_offset_setting @ 0.732 is its nearest neighbour and is deliberately unmapped " +
      "— the right precedent, reached for the right reason.",
  },
  {
    skillId: "skill_welding_machine_consumable_changeover",
    label: "Welding machine consumable changeover",
    family: "welding-support",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: ATTRIBUTE("Changing wire, tips and nozzles is routine upkeep around a welding set."),
  },
  {
    skillId: "skill_electrode_selection",
    label: "Electrode selection",
    family: "welding-support",
    candidates: ["mskill_arc_welder"],
    disposition: "REVIEW",
    confidence: "low",
    rationale:
      "Unlike the rest of this family it DOES imply a process — electrodes are stick/arc " +
      "consumables, so it is the one welding-support skill with a defensible specific target. " +
      "Against that: selecting a consumable is still an attribute of doing the work.",
  },
];

// ---------------------------------------------------------------------------
// Validation. The pack is data, and data rots — these make it fail loudly.
// ---------------------------------------------------------------------------

export interface TriageProblem {
  readonly kind:
    | "MISSING_SKILL"
    | "UNKNOWN_SKILL"
    | "DUPLICATE"
    | "UNKNOWN_MATCH_SKILL"
    | "CANDIDATES_WITHOUT_MATCH"
    | "MATCH_WITHOUT_CANDIDATES"
    | "EMPTY_RATIONALE";
  readonly detail: string;
}

/**
 * Check the pack against the promotable universe and the match vocabulary.
 *
 * The rule worth naming: MATCHED requires candidates, and INTENTIONALLY_UNMATCHED forbids
 * them. A row proposing `mskill_fitter` while dispositioned UNMATCHED is not a harmless
 * inconsistency — it is a mapping sitting in a field nobody reads, one careless edit away from
 * being applied. REVIEW may carry candidates, because naming what a reviewer should weigh is
 * the entire point of a review row.
 */
export function validateTriage(
  rows: readonly TriageRow[],
  promotable: readonly string[],
  validMatchSkills: ReadonlySet<string>,
): TriageProblem[] {
  const problems: TriageProblem[] = [];
  const seen = new Set<string>();
  const universe = new Set(promotable);

  for (const r of rows) {
    if (seen.has(r.skillId)) problems.push({ kind: "DUPLICATE", detail: r.skillId });
    seen.add(r.skillId);
    if (!universe.has(r.skillId)) problems.push({ kind: "UNKNOWN_SKILL", detail: r.skillId });

    for (const c of r.candidates) {
      if (!validMatchSkills.has(c)) {
        problems.push({ kind: "UNKNOWN_MATCH_SKILL", detail: `${r.skillId} -> ${c}` });
      }
    }
    if (r.disposition === "INTENTIONALLY_UNMATCHED" && r.candidates.length > 0) {
      problems.push({ kind: "CANDIDATES_WITHOUT_MATCH", detail: r.skillId });
    }
    if (r.disposition === "MATCHED" && r.candidates.length === 0) {
      problems.push({ kind: "MATCH_WITHOUT_CANDIDATES", detail: r.skillId });
    }
    if (r.rationale.trim().length < 20) {
      problems.push({ kind: "EMPTY_RATIONALE", detail: r.skillId });
    }
  }

  for (const id of promotable) {
    if (!seen.has(id)) problems.push({ kind: "MISSING_SKILL", detail: id });
  }
  return problems;
}

export interface TriageSummary {
  readonly total: number;
  readonly matched: number;
  readonly intentionallyUnmatched: number;
  readonly review: number;
  /** Families with no `mskill_*` at all — a vocabulary finding, not a mapping backlog. */
  readonly unrepresentedFamilies: readonly FamilyKey[];
  readonly skillsInUnrepresentedFamilies: number;
  readonly falseFriendsNamed: number;
}

export function summarizeTriage(rows: readonly TriageRow[]): TriageSummary {
  const unrepresented = (Object.keys(FAMILIES) as FamilyKey[]).filter(
    (f) => !FAMILIES[f].represented,
  );
  return {
    total: rows.length,
    matched: rows.filter((r) => r.disposition === "MATCHED").length,
    intentionallyUnmatched: rows.filter((r) => r.disposition === "INTENTIONALLY_UNMATCHED").length,
    review: rows.filter((r) => r.disposition === "REVIEW").length,
    unrepresentedFamilies: unrepresented,
    skillsInUnrepresentedFamilies: rows.filter((r) => !FAMILIES[r.family].represented).length,
    falseFriendsNamed: rows.filter((r) => r.falseFriend !== undefined).length,
  };
}

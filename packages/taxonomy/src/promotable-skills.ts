/**
 * The promotable growth batch — the SECOND universe the match bridge must cover.
 *
 * ===========================================================================
 * WHY THIS LIST EXISTS IN THE TAXONOMY PACKAGE
 * ===========================================================================
 * `ATTRIBUTE_TO_MATCH_SKILLS` used to be exhaustive over `SKILL_CORPUS` alone — 49 seeds. That
 * sounded like full protection and was not: a skill that never entered `SKILL_CORPUS` was not
 * "unmapped and failing", it was OUTSIDE THE QUESTION THE TEST ASKED. 96 promotable skills sat
 * in exactly that blind spot, and could have gone `active` — visible to canonicalization and
 * retrieval, reaching nothing at match time — with no test failing anywhere.
 *
 * Q1 (owner-ratified, 2026-08-26) closes it: **every promotable skill must carry a disposition,
 * MATCHED or INTENTIONALLY_UNMATCHED, before it can be promoted.** The exhaustiveness test now
 * asks its question of `SKILL_CORPUS` ∪ this list.
 *
 * PROVENANCE. These are the 96 `skill_id`s of
 * `packages/db/data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d/accepted-skills.jsonl`,
 * the phase-9d derived promotion scope. The list is duplicated here rather than read from disk
 * because this package must not reach into another package's data directory — and duplication
 * is safe only because it is GUARDED: `q1-disposition-triage.test.ts` in `@badabhai/db` asserts
 * this array equals that file exactly, so the two cannot drift.
 *
 * Order matches the batch file.
 */
export const PROMOTABLE_SKILL_IDS: readonly string[] = [
  "skill_torque_wrench_operation",
  "skill_wiring_harness_routing",
  "skill_assembly_line_sequencing",
  "skill_fastener_selection_and_tightening",
  "skill_sub_assembly_quality_checking",
  "skill_battery_cell_stacking",
  "skill_battery_terminal_crimping",
  "skill_electrolyte_filling",
  "skill_battery_pack_leak_testing",
  "skill_battery_capacity_checking",
  "skill_chemical_handling_safety",
  "skill_engine_overhauling",
  "skill_brake_system_servicing",
  "skill_suspension_and_steering_repair",
  "skill_clutch_and_gearbox_repair",
  "skill_vehicle_diagnostic_scanning",
  "skill_wheel_alignment_and_balancing",
  "skill_body_panel_alignment",
  "skill_lathe_chuck_mounting",
  "skill_cutting_tool_selection",
  "skill_coolant_management",
  "skill_first_piece_approval",
  "skill_mortar_mixing",
  "skill_stone_dressing",
  "skill_brick_and_block_laying",
  "skill_wall_plumb_and_level_checking",
  "skill_plastering",
  "skill_scaffolding_erection",
  "skill_concrete_curing",
  "skill_stone_joint_pointing",
  "skill_site_material_stacking",
  "skill_house_wiring_installation",
  "skill_conduit_bending_and_laying",
  "skill_earthing_and_bonding",
  "skill_cable_termination_and_jointing",
  "skill_electrical_fault_finding",
  "skill_distribution_board_assembly",
  "skill_insulation_resistance_testing",
  "skill_motor_connection_and_starter_wiring",
  "skill_electrical_safety_and_lockout",
  "skill_control_panel_wiring",
  "skill_switchgear_installation",
  "skill_sheet_metal_marking_and_layout",
  "skill_shearing_machine_operation",
  "skill_press_brake_bending",
  "skill_punching_machine_operation",
  "skill_structural_fit_up_and_tacking",
  "skill_refrigerant_charging",
  "skill_brazing_of_copper_lines",
  "skill_vacuum_pump_evacuation",
  "skill_compressor_replacement",
  "skill_refrigerant_leak_detection",
  "skill_thermostat_and_control_wiring",
  "skill_ducting_installation",
  "skill_split_unit_installation",
  "skill_indoor_unit_servicing_and_cleaning",
  "skill_customer_site_handover",
  "skill_bearing_replacement",
  "skill_belt_and_chain_drive_alignment",
  "skill_lubrication_schedule_execution",
  "skill_vibration_and_noise_fault_diagnosis",
  "skill_pump_and_valve_repair",
  "skill_shaft_and_coupling_alignment",
  "skill_sanitary_fixture_installation",
  "skill_leak_repair_in_water_lines",
  "skill_solvent_cement_jointing",
  "skill_drain_cleaning_and_unclogging",
  "skill_pipe_bending",
  "skill_pressure_testing_of_pipelines",
  "skill_pipe_support_and_clamping",
  "skill_visual_defect_identification",
  "skill_inspection_report_recording",
  "skill_rejection_tagging_and_segregation",
  "skill_surface_finish_inspection",
  "skill_hardness_testing",
  "skill_non_destructive_testing_of_castings",
  "skill_stock_counting",
  "skill_inventory_record_keeping",
  "skill_goods_receipt_verification",
  "skill_bin_location_management",
  "skill_dispatch_documentation",
  "skill_material_handling_equipment_operation",
  "skill_pallet_stacking_and_loading",
  "skill_issue_and_requisition_control",
  "skill_order_picking_and_packing",
  "skill_forklift_operation",
  "skill_barcode_scanning",
  "skill_gas_torch_flame_setting",
  "skill_oxy_acetylene_cylinder_handling",
  "skill_weld_bead_inspection",
  "skill_welding_joint_preparation",
  "skill_distortion_control_in_weldments",
  "skill_weld_spatter_cleaning",
  "skill_weld_program_parameter_setting",
  "skill_welding_machine_consumable_changeover",
  "skill_electrode_selection",
];

/// The two labels the form-flow mockups print around each question: the
/// CATEGORY after the step in the header ("STEP 5 OF 6 • TOOLING & FIXTURES")
/// and the TOPIC on the white progress strip ("CLAMPING & WORKHOLDING").
///
/// Packs carry no grouping field, so these come from the question's own
/// `question_key` — every key the sixteen form trades ship is listed. The
/// table is also the Technical Skills walk's keep/drop source
/// (`trade_form_section_walk.dart`), which is why it must stay complete:
/// `trade_form_topics_coverage_test.dart` reads the shipped packs and turns CI
/// red the moment a form pack carries a key this table does not name. (It went
/// stale once already — the seven form trades shipped 2026-09-24/25 added 68
/// keys nobody listed, and their tenure/level questions fell into Technical
/// Skills.)
///
/// For DISPLAY an unknown key (a pack newer than this app) still falls back to
/// its own words, readable, so a header is never blank or invented — see
/// [formTopicFor]. Deciding what a key MEANS uses [knownFormTopicFor], which
/// never guesses.
library;

/// (category, topic) for [questionKey], for display.
///
/// Never blank: a key the table does not know prints its own words.
(String, String) formTopicFor(String questionKey) {
  final (String, String)? known = knownFormTopicFor(questionKey);
  if (known != null) return known;
  final String words = _readable(questionKey);
  return (words, words);
}

/// (category, topic) for [questionKey] when the table KNOWS the key, else
/// null.
///
/// The readable-words fallback in [formTopicFor] is right for a header and
/// wrong for a decision: a key's own words are not a category, so anything
/// that keeps or drops a question by its category (the section walks) must
/// read this and treat null as "unknown" — never as a category of its own.
(String, String)? knownFormTopicFor(String questionKey) =>
    _kTopics[questionKey];

/// (category, topic) for the non-question marker pages.
const (String, String) kPreferencesTopic =
    ('Availability & terms', 'Availability & preferences');
const (String, String) kEmploymentTopic = ('Work history', 'Past jobs');
const (String, String) kQualificationsTopic =
    ('Qualifications', 'Education & certificates');

String _readable(String key) {
  final String s = key.replaceAll('_', ' ').trim();
  if (s.isEmpty) return '';
  return s[0].toUpperCase() + s.substring(1);
}

const (String, String) _experience = ('Experience', 'Work experience');
const (String, String) _level = ('Experience', 'Skill level');
const (String, String) _machines = ('Machines', 'Machines & equipment');
const (String, String) _capability = ('Machines', 'Machine capability');
const (String, String) _operations = ('Operations', 'Operations & capability');
const (String, String) _setting = ('Machine setting', 'Setting & offsets');
const (String, String) _material = ('Material', 'Materials worked');
const (String, String) _measuring = ('Quality & inspection', 'Measuring instruments');
const (String, String) _quality = ('Quality & inspection', 'Quality checks');
const (String, String) _precision = ('Quality & inspection', 'Precision & finish');
const (String, String) _drawing = ('Drawing & design', 'Drawings');
const (String, String) _software = ('Programming & software', 'Software & programming');
const (String, String) _trouble = ('Troubleshooting', 'Problems & fixes');
const (String, String) _sector = ('Industry', 'Industry experience');
const (String, String) _training = ('Training', 'ITI & certification');
const (String, String) _process = ('Process', 'Process & technique');
const (String, String) _tooling = ('Tooling & fixtures', 'Tools & dies');
const (String, String) _equipment = ('Machines', 'Equipment');
const (String, String) _changeover = ('Machine setting', 'Setting & changeover');
const (String, String) _safety = ('Safety', 'Safety practice');
const (String, String) _overhaul = ('Maintenance', 'Overhaul');
const (String, String) _fluidPower =
    ('Hydraulics & pneumatics', 'Hydraulic & pneumatic work');

const Map<String, (String, String)> _kTopics = <String, (String, String)>{
  // Experience & level
  'turning_experience': _experience, 'milling_experience': _experience,
  'grinding_experience': _experience, 'machining_experience': _experience,
  'toolroom_experience': _experience, 'welding_experience': _experience,
  'coating_experience': _experience, 'programming_experience': _experience,
  'drafting_experience': _experience,
  'machining_level': _level, 'toolroom_level': _level, 'welder_level': _level,
  // Phase 2 #2 (qp_cnc_grinding@6) — the one separating confirm (asked of
  // setter and setter-cum-programmer) is a level follow-up, not craft.
  'grinding_setting_confirm': _level,
  // Phase 2 #1 (qp_tool_die_making@2) — the separating confirms are level
  // follow-ups, not craft: Experience, left out of Technical Skills. The
  // training-institute row walks as training.
  'toolroom_skilled_confirm': _level, 'toolroom_senior_confirm': _level,
  'tool_training_institute': _training,
  // Track B #4 (qp_conventional_machining@2) — the separating confirms are
  // level follow-ups, not craft: Experience, left out of Technical Skills.
  'machining_skilled_confirm': _level, 'machining_senior_confirm': _level,
  'coating_level': _level,
  // Phase 2 #4 (qp_powder_coating@2) — the one separating confirm (asked of
  // skilled and senior) is a level follow-up, not craft.
  'coating_skilled_confirm': _level,
  // Track B #3 (qp_welding_trade@2) — the separating confirms are level
  // follow-ups, not craft: Experience, left out of Technical Skills.
  'welder_skilled_confirm': _level, 'welder_senior_confirm': _level,
  'turning_level': _level, 'milling_level': _level, 'grinding_level': _level,
  'cam_level': _level,
  // Track A #1 (qp_cnc_turning@6) — the separating confirms are level
  // follow-ups, not craft: Experience, left out of Technical Skills.
  'setting_confirm': _level, 'program_edit_confirm': _level,
  'program_write_confirm': _level, 'team_confirm': _level,
  // Track A #2 (qp_vmc_milling@6) — same mechanism, same category.
  'milling_setting_confirm': _level, 'milling_program_edit_confirm': _level,
  'milling_program_write_confirm': _level, 'milling_team_confirm': _level,
  // Track A #3 (qp_cam_programming@4) — same mechanism, same category.
  'cam_program_confirm': _level, 'cam_senior_confirm': _level,
  'cam_lead_confirm': _level, 'cam_team_confirm': _level,
  // Phase 2 #10 (qp_production_supervisor) — chat-only pack, like EDM below.
  // `sector_worked` is shared and already listed.
  'supervision_experience': _experience, 'supervision_level': _level,
  'supervision_report_confirm': _level, 'supervision_team_size': _level,
  'supervision_area': _operations, 'supervision_machines': _machines,
  'supervision_systems': _operations,
  'supervision_trade_background': _experience,
  // Phase 2 #9 (qp_injection_moulding) — chat-only pack, like EDM below.
  'moulding_experience': _experience, 'moulding_level': _level,
  'moulding_setting_confirm': _level, 'moulding_senior_confirm': _level,
  'moulding_machine_brand': _machines, 'moulding_tonnage': _capability,
  'moulding_material': _material, 'moulding_process_work': _operations,
  'moulding_defects': _trouble, 'moulding_training_institute': _training,
  // Phase 2 #11 (qp_foundry_forging) — chat-only pack, like heat treatment below.
  'foundry_experience': _experience, 'foundry_level': _level,
  'foundry_skilled_confirm': _level,
  'foundry_process': _process, 'foundry_material': _material,
  'foundry_equipment': _equipment, 'foundry_testing': _quality,
  // Phase 2 #8 (qp_heat_treatment) — chat-only pack, like EDM below.
  'heat_experience': _experience, 'heat_level': _level,
  'heat_skilled_confirm': _level,
  'heat_process': _process, 'heat_furnace': _equipment,
  'heat_testing': _quality, 'heat_material': _material,
  // Phase 2 #7 (qp_edm_wirecut) — chat-only pack, like PLC below.
  'edm_experience': _experience, 'edm_level': _level,
  'edm_setting_confirm': _level, 'edm_program_confirm': _level,
  'edm_machine': _machines, 'edm_brand': _machines,
  'edm_program_source': _software, 'edm_tolerance': _precision,
  'edm_work_type': _operations,
  // Phase 2 #6 (qp_plc_automation) — chat-only pack, no form walks it; each
  // key is listed with its true category, as for the 3D pack below.
  'plc_experience': _experience, 'plc_level': _level,
  'plc_technician_confirm': _level, 'plc_senior_confirm': _level,
  'plc_brand': _software, 'plc_work': _operations,
  'plc_hmi_brand': _software, 'plc_field_devices': _equipment,
  // Track A #4 (qp_cad_design_3d) — chat-only pack, no form walks it, but the
  // coverage test reads every tier-tagged active pack: each key is listed with
  // its true category so the table stays complete rather than failing closed.
  'design_experience': _experience, 'design_level': _level,
  'design_software': _software, 'design_work_area': _operations,
  'design_depth': _operations, 'design_tolerance': _precision,
  'design_industry': _sector, 'design_senior_confirm': _level,
  'design_lead_confirm': _level, 'design_team_confirm': _level,
  // Track A #5 (qp_cad_drafting@2) — the level question, the sheet-5 rows and
  // the separating confirms, with their true categories.
  'cad_level': _level, 'drawing_subject': _drawing, 'drawing_from_model': _software,
  'cad_senior_confirm': _level, 'cad_lead_confirm': _level, 'cad_team_confirm': _level,
  // Machines
  'turning_machine': _machines, 'milling_machine': _machines,
  'grinding_machine': _machines, 'machining_machine': _machines,
  'toolroom_machine': _machines, 'machine_programmed': _machines,
  'grinding_type': _machines, 'iti_workshop_machines': _machines,
  'welding_equipment': ('Machines', 'Equipment'),
  'coating_equipment': ('Machines', 'Equipment'),
  'booth_type': ('Machines', 'Equipment'),
  'controller_brand': ('Machines', 'Controller & control system'),
  'axis_capability': _capability, 'advanced_capability': _capability,
  'turning_capacity': _capability, 'press_tonnage': _capability,
  // Track B #4 (@2): the CNC crossover and the work-type row walk with their
  // true categories (machines / operations), like every tier-tagged key must.
  'machining_cnc': _machines,
  'machining_work_type': _operations,
  // Operations
  'turning_operation': ('Turning operations', 'Operations & capability'),
  'milling_operation': ('Milling operations', 'Operations & capability'),
  'machining_operation': ('Machining operations', 'Operations & capability'),
  'advanced_work': _operations, 'fabrication_work': _operations,
  'toolroom_work': _operations, 'edm_work': _operations,
  'heat_treatment_work': _operations, 'die_design_work': _operations,
  'programming_work': _software,
  // Tooling
  'workholding': ('Tooling & fixtures', 'Clamping & workholding'),
  'tooling_made': _tooling, 'tool_steel': _tooling, 'tool_grinding': _tooling,
  'wheel_type': ('Tooling & fixtures', 'Wheels & dressing'),
  'dressing_method': ('Tooling & fixtures', 'Wheels & dressing'),
  // Setting
  'setting_operation': _setting, 'setting_work': _setting,
  'machine_setting': _setting,
  'gun_setting': ('Equipment setting', 'Setting & changeover'),
  'colour_change': ('Equipment setting', 'Setting & changeover'),
  // Material
  'material_worked': _material, 'substrate_worked': _material,
  'coating_material': _material,
  // Quality
  'measuring_tools': _measuring,
  'quality_work': _quality, 'inspection_work': _quality,
  'coating_checks': _quality, 'drawing_check_work': _quality,
  'tolerance_band': _precision, 'surface_finish': _precision,
  'film_thickness': _precision,
  // Drawing & design
  'drawing_reading': ('Drawing & design', 'Drawing reading'),
  'drawing_standards': _drawing, 'drawing_type': _drawing,
  'drawing_work': _drawing, 'output_produced': _drawing,
  'design_input_source': _drawing, 'design_work': _drawing,
  // Programming & software
  'cad_software': _software, 'cad_modules': _software,
  'cad_model_handling': _software, 'cam_software': _software,
  'simulation_work': _software, 'post_processor_work': _software,
  'programming_level': _software, 'programming_mode': _software,
  // Track A #3 (qp_cam_programming@4): the sheet-3 Advanced rows describe
  // the worker's craft, so they walk with Technical Skills (unlike the
  // level-adjacent software keys above, which stay out of it).
  'part_types': _operations, 'extra_work': _operations,
  // Welding / coating process
  'welding_process': _process, 'coating_process': _process,
  'surface_prep': _process, 'oven_schedule': _process,
  // Phase 2 #4 (qp_powder_coating@2) — the new bath / chemical row is process
  // craft, beside surface prep and the oven schedule.
  'coating_bath_work': _process,
  'joint_type': ('Welding', 'Joints & positions'),
  'welding_position': ('Welding', 'Joints & positions'),
  'electrode_type': ('Welding', 'Consumables'),
  'plate_thickness': ('Welding', 'Plate thickness'),
  // Track B #3 (@2) — a credential, but the résumé prints it in the trade's
  // CAPABILITY block ('Certificate', trade-resume-map.ts), so it stays a skill
  // here (electrical_licence precedent).
  'welder_certificate': ('Welding', 'Welder certificate'),
  // Troubleshooting
  'troubleshooting': _trouble, 'die_troubleshooting': _trouble,
  'weld_defect': _trouble, 'coating_defects': _trouble,
  // Industry & training
  'sector_worked': _sector, 'sector_drawn': _sector, 'sector_studied': _sector,
  'iti_project_work': _training, 'cad_training_source': _training,
  'trade_test_status': _training,

  // ── The seven form trades shipped 2026-09-24/25 ──────────────────────────
  // Their tenure (`*_experience`) and self-level (`*_level`) questions are
  // Experience, exactly like the machining ones above; everything else is the
  // trade's own capability. Shared keys (material_worked, measuring_tools,
  // drawing_reading, sector_worked, iti_*, trade_test_status, press_tonnage)
  // are already listed above.
  //
  // Sheet metal fabrication (qp_sheet_metal_fab)
  'sheet_metal_experience': _experience, 'sheet_metal_level': _level,
  // Track B #5 (@2) — the separating confirms are level follow-ups, same
  // mechanism as the earlier confirms: Experience, left out of Technical Skills.
  'sheet_skilled_confirm': _level, 'sheet_senior_confirm': _level,
  'sheet_metal_machine': _machines,
  // Track B #5 (@2): the new product + extra-work rows walk with their true
  // categories (sector / operations), like every tier-tagged key must.
  'sheet_metal_product': _sector,
  'sheet_metal_extra': _operations,
  'sheet_operation': ('Sheet metal operations', 'Operations & capability'),
  'sheet_thickness': ('Sheet metal operations', 'Sheet thickness'),
  'assembly_finishing': ('Sheet metal operations', 'Assembly & finishing'),
  'press_brake_setting': _changeover,
  'layout_calculation': ('Drawing & design', 'Layout & flat pattern'),
  'nesting_software': _software,
  // Press operation (qp_press_operation)
  'press_experience': _experience, 'press_level': _level,
  // Phase 2 #3 (qp_press_operation@2) — the one separating confirm (asked of
  // setter and senior) is a level follow-up, not craft.
  'press_setting_confirm': _level,
  'press_machine': _machines, 'press_stroke_rate': _capability,
  'press_setting': _changeover, 'press_die_type': _tooling,
  'press_safety': _safety, 'press_defect': _trouble,
  'press_maintenance': ('Maintenance', 'Machine upkeep'),
  // Fitter (qp_fitter)
  'fitting_experience': _experience, 'fitter_level': _level,
  // Track B #1 (@2) — the separating confirms are level follow-ups, same
  // mechanism as the Turner/CAM confirms: Experience, left out of Technical Skills.
  'fitter_skilled_confirm': _level, 'fitter_team_confirm': _level,
  'fitter_equipment': _equipment,
  'fitter_work_type': ('Fitting operations', 'Type of fitting work'),
  'fitting_work': ('Fitting operations', 'Bench & assembly work'),
  'fitting_alignment': ('Fitting operations', 'Alignment accuracy'),
  'fitter_erection': ('Fitting operations', 'Erection & commissioning'),
  'fitter_hydraulic_work': _fluidPower, 'fitter_overhaul': _overhaul,
  'fitter_fault_finding': _trouble,
  // Maintenance technician (qp_maintenance_tech)
  'maintenance_experience': _experience, 'maintenance_level': _level,
  'maintenance_equipment': _machines,
  'maintenance_discipline': ('Maintenance', 'Type of maintenance'),
  'maintenance_type': ('Maintenance', 'Maintenance work'),
  'maintenance_response': ('Maintenance', 'Breakdown response'),
  'maintenance_documentation': ('Maintenance', 'Records & documentation'),
  'maintenance_fluid_power': _fluidPower, 'maintenance_overhaul': _overhaul,
  // Phase 2 #5 (qp_maintenance_tech@2) — the separating confirm is a level
  // follow-up; the CNC and utility rows are maintenance craft.
  'maintenance_senior_confirm': _level,
  'maintenance_cnc_work': _overhaul,
  'maintenance_utilities': ('Maintenance', 'Utilities'),
  'maintenance_fault_finding': _trouble,
  // Industrial electrician (qp_industrial_electrician)
  'electrical_experience': _experience, 'electrician_level': _level,
  // Track B #2 (@2) — the separating confirm is a level follow-up, same
  // mechanism as the Turner/CAM/fitter confirms: Experience, left out of
  // Technical Skills.
  'electrician_senior_confirm': _level,
  'electrical_equipment': _equipment,
  'electrical_work_type': ('Electrical work', 'Type of electrical work'),
  'panel_motor_work': ('Electrical work', 'Panels & motors'),
  'electrical_voltage': ('Electrical work', 'Voltage range'),
  'control_circuit': ('Electrical work', 'Control circuits'),
  // A credential, but the résumé prints it in the trade's CAPABILITY block
  // ('Licence', trade-resume-map.ts), so it stays a skill here.
  'electrical_licence': ('Electrical work', 'Electrical licence'),
  'electrical_safety': _safety, 'motor_fault': _trouble,
  // Assembly line (qp_assembly_line)
  'assembly_experience': _experience, 'assembly_level': _level,
  // Track B #6 (@2) — the separating confirms are level follow-ups, not
  // craft: Experience, left out of Technical Skills.
  'assembly_skilled_confirm': _level, 'assembly_team_confirm': _level,
  'assembly_stage': ('Assembly operations', 'Line stages'),
  'assembly_line_product': ('Assembly operations', 'Assemblies worked on'),
  // Track B #6 (@2): the new skill/company rows walk with their true
  // categories, like every tier-tagged key must.
  'assembly_skill': _operations,
  'company_type': ('Assembly operations', 'Company type'),
  'assembly_joining': ('Assembly operations', 'Joining work'),
  'assembly_takt_time': ('Assembly operations', 'Takt time'),
  'assembly_station_count': ('Assembly operations', 'Stations handled'),
  'assembly_responsibility': ('Assembly operations', 'Line responsibilities'),
  'assembly_practice': ('Assembly operations', 'Shop-floor practice'),
  'assembly_tool': ('Tooling & fixtures', 'Hand & power tools'),
  'assembly_defect': _trouble,
  // Quality inspection (qp_quality_inspection)
  'inspection_experience': _experience, 'inspection_level': _level,
  // Track B #7 (@2) — the separating confirms are level follow-ups, not
  // craft: Experience, left out of Technical Skills.
  'inspection_senior_confirm': _level, 'inspection_engineer_confirm': _level,
  'inspection_stage': ('Quality & inspection', 'Inspection stages'),
  'inspection_least_count': ('Quality & inspection', 'Least count'),
  'inspection_standard': ('Quality & inspection', 'Quality standards'),
  'inspection_documentation': ('Quality & inspection', 'Quality documents'),
  'inspection_cmm_work': ('Quality & inspection', 'CMM work'),
  'inspection_rejection_work': ('Quality & inspection', 'Rejection handling'),
  'inspection_audit_work': ('Quality & inspection', 'Audits & customers'),
  // CEO pack v2, Wave 1 (#3008) — the compiled sheets. The roles are disabled (#3004), so no
  // form walks these yet; listed so the walk is right the day a trade is switched on. Same
  // rules as above: tenure, level and every rung confirm → Experience; customer and plant
  // sector → Industry; branch, training exposure and belts → Training; craft → kept.
  // qp_cnc_router (T21)
  'router_bed_size': _machines,
  'router_design_source': _drawing,
  'router_design_work': _software,
  'router_experience': _experience,
  'router_level': _level,
  'router_machine_type': _machines,
  'router_product': _operations,
  'router_programmer_confirm': _level,
  'router_setter_confirm': _level,
  'router_setting_work': _setting,
  'router_software': _software,
  'router_team_confirm': _level,
  'router_tooling': _tooling,
  'router_work_type': _operations,
  // qp_edm_wirecut@2 (T17)
  'edm_cam_software': _software,
  'edm_job_type': _operations,
  'edm_parameter_work': _setting,
  'edm_setting_work': _setting,
  'edm_team_confirm': _level,
  'edm_wire_electrode': _tooling,
  // qp_heat_treatment@2 (T27)
  'ht_atmosphere': _process,
  'ht_cycle_setting': _setting,
  'ht_daily_work': _operations,
  'ht_furnace_make': _machines,
  'ht_furnace_upkeep': _overhaul,
  'ht_part': _operations,
  'ht_quality_system': _quality,
  'ht_quench_media': _process,
  'ht_senior_confirm': _level,
  'ht_team_confirm': _level,
  // qp_injection_moulding@2 (T29)
  'imm_auxiliary': _machines,
  'imm_daily_work': _operations,
  'imm_machine_type': _machines,
  'imm_parameter_setting': _setting,
  'imm_process_control': _process,
  'imm_special_process': _process,
  'imm_team_confirm': _level,
  // qp_cmm (T33)
  'cmm_alignment_method': _measuring,
  'cmm_daily_work': _operations,
  'cmm_experience': _experience,
  'cmm_gdt_evaluation': _quality,
  'cmm_level': _level,
  'cmm_machine_type': _machines,
  'cmm_make': _machines,
  'cmm_part_type': _operations,
  'cmm_probe_system': _measuring,
  'cmm_programmer_confirm': _level,
  'cmm_programming_level': _software,
  'cmm_quality_system': _quality,
  'cmm_report_type': _quality,
  'cmm_senior_confirm': _level,
  'cmm_software': _software,
  'cmm_team_confirm': _level,
  // qp_quality_engineer (T37)
  'qe_audit_work': _quality,
  'qe_core_tools': _quality,
  'qe_customer_handled': _sector,
  'qe_documents': _operations,
  'qe_experience': _experience,
  'qe_function': _operations,
  'qe_improvement_work': _operations,
  'qe_lead_confirm': _level,
  'qe_level': _level,
  'qe_problem_solving': _trouble,
  'qe_process_area': _sector,
  'qe_qualification_branch': _training,
  'qe_senior_engineer_confirm': _level,
  'qe_software': _software,
  'qe_standards': _quality,
  'qe_supplier_work': _quality,
  'qe_targets_owned': _quality,
  'qe_team_confirm': _level,
  'qe_training_exposure': _training,
  // qp_plc_automation@2 (T38)
  'plc_advanced_system': _machines,
  'plc_commissioning_work': _operations,
  'plc_drawing_reading': ('Drawing & design', 'Drawing reading'),
  'plc_drive_servo': _machines,
  'plc_lead_confirm': _level,
  'plc_machine_type': _machines,
  'plc_network': _software,
  'plc_programming_scope': _software,
  'plc_project_role': _operations,
  'plc_software': _software,
  'plc_team_confirm': _level,
  // qp_maintenance_engineer (T43)
  'me_breakdown_analysis': _trouble,
  'me_daily_work': _operations,
  'me_department_targets': _operations,
  'me_drawing_reading': ('Drawing & design', 'Drawing reading'),
  'me_experience': _experience,
  'me_function': _operations,
  'me_lead_confirm': _level,
  'me_level': _level,
  'me_machine_type': _machines,
  'me_machines_handled': _capability,
  'me_qualification_branch': _training,
  'me_record_system': _software,
  'me_senior_engineer_confirm': _level,
  'me_shutdown_projects': _overhaul,
  'me_spares_vendor': _overhaul,
  'me_statutory_audit': _safety,
  'me_team_confirm': _level,
  'me_technical_area': _trouble,
  'me_tpm_improvement': _overhaul,
  'me_training_exposure': _training,
  // qp_production_supervisor@2 (T45)
  'prodsup_audit_exposure': _quality,
  'prodsup_changeover_work': _setting,
  'prodsup_daily_work': _operations,
  'prodsup_improvement_work': _operations,
  'prodsup_incharge_confirm': _level,
  'prodsup_labour_type': _operations,
  'prodsup_line_data': _operations,
  'prodsup_people_work': _operations,
  'prodsup_production_entry': _software,
  'prodsup_safety_five_s': _safety,
  'prodsup_team_confirm': _level,
  // qp_production_engineer (T46)
  'prod_cost_work': _operations,
  'prod_customer_served': _sector,
  'prod_daily_work': _operations,
  'prod_documents_owned': _operations,
  'prod_erp_system': _software,
  'prod_experience': _experience,
  'prod_improvement_work': _operations,
  'prod_lead_confirm': _level,
  'prod_level': _level,
  'prod_manpower_handled': _level,
  'prod_metrics_tracked': _operations,
  'prod_people_work': _operations,
  'prod_qualification_branch': _training,
  'prod_quality_system': _quality,
  'prod_senior_engineer_confirm': _level,
  'prod_shop_type': _operations,
  'prod_team_confirm': _level,
  'prod_training_exposure': _training,
  // qp_process_engineer (T47)
  'proc_documents_owned': _operations,
  'proc_experience': _experience,
  'proc_function': _operations,
  'proc_improvement_work': _operations,
  'proc_lead_confirm': _level,
  'proc_level': _level,
  'proc_new_line_work': _process,
  'proc_process_type': _process,
  'proc_qualification_branch': _training,
  'proc_quality_system': _quality,
  'proc_senior_engineer_confirm': _level,
  'proc_six_sigma_belt': _training,
  'proc_software': _software,
  'proc_team_confirm': _level,
  'proc_time_study': _process,
  'proc_tooling_work': _tooling,
  'proc_training_exposure': _training,
  // qp_npd_engineer (T48)
  'npd_costing_work': _operations,
  'npd_customer_served': _sector,
  'npd_documents_owned': _operations,
  'npd_experience': _experience,
  'npd_function': _operations,
  'npd_lead_confirm': _level,
  'npd_level': _level,
  'npd_part_process': _operations,
  'npd_ppap_work': _quality,
  'npd_projects_handled': _operations,
  'npd_qualification_branch': _training,
  'npd_senior_engineer_confirm': _level,
  'npd_software': _software,
  'npd_team_confirm': _level,
  'npd_tooling_source': _tooling,
  'npd_training_exposure': _training,
  'npd_trial_work': _tooling,
  'npd_validation_tests': _quality,
  // qp_ppc (T52)
  'ppc_capacity_planning': _operations,
  'ppc_customer_schedule': _operations,
  'ppc_documents': _operations,
  'ppc_erp_system': _software,
  'ppc_excel_skill': _software,
  'ppc_experience': _experience,
  'ppc_function': _operations,
  'ppc_improvement_work': _operations,
  'ppc_inventory_control': _operations,
  'ppc_kpi_reporting': _operations,
  'ppc_lead_confirm': _level,
  'ppc_level': _level,
  'ppc_material_planning': _operations,
  'ppc_plan_type': _operations,
  'ppc_plant_type': _sector,
  'ppc_qualification_branch': _training,
  'ppc_senior_engineer_confirm': _level,
  'ppc_team_confirm': _level,
  'ppc_training_exposure': _training,
  // qp_purchase (T54)
  'purchase_annual_value': _operations,
  'purchase_category': _operations,
  'purchase_commercial_terms': _operations,
  'purchase_costing': _operations,
  'purchase_documents': _operations,
  'purchase_erp_system': _software,
  'purchase_experience': _experience,
  'purchase_function': _operations,
  'purchase_import_work': _operations,
  'purchase_improvement_work': _operations,
  'purchase_lead_confirm': _level,
  'purchase_level': _level,
  'purchase_qualification_branch': _training,
  'purchase_senior_engineer_confirm': _level,
  'purchase_team_confirm': _level,
  'purchase_training_exposure': _training,
  'purchase_vendor_count': _operations,
  'purchase_vendor_development': _operations,
  // qp_cad_design_3d@2 (T58)
  'design_daily_work': _operations,
  'design_machine_elements': _drawing,
  'design_pdm_plm': _software,
  'design_process_knowledge': _process,
  'design_project_ownership': _operations,
  'design_qualification_branch': _training,
  'design_tool_work': _tooling,
  'design_training_exposure': _training,
  'design_validation': _quality,
  'design_work_input': _drawing,
  // The foundry split (#3009) — same rules. Die care is tooling (the die is the tool).
  // qp_foundry_casting (T24); its five reused keys are listed above with the old foundry form.
  'foundry_casting_product': _operations,
  'foundry_casting_weight': _operations,
  'foundry_core_process': _process,
  'foundry_furnace': _machines,
  'foundry_melt_work': _operations,
  'foundry_moulding_method': _process,
  'foundry_section': _operations,
  'foundry_senior_confirm': _level,
  'foundry_team_confirm': _level,
  // qp_die_casting (T25)
  'diecast_daily_work': _operations,
  'diecast_die_care': _tooling,
  'diecast_experience': _experience,
  'diecast_level': _level,
  'diecast_machine_brand': _machines,
  'diecast_melting_work': _operations,
  'diecast_parameter': _setting,
  'diecast_part': _operations,
  'diecast_process': _process,
  'diecast_senior_confirm': _level,
  'diecast_setter_confirm': _level,
  'diecast_setting_work': _setting,
  'diecast_team_confirm': _level,
  'diecast_tonnage': _machines,
  // qp_forging (T26)
  'forging_capacity': _machines,
  'forging_cold_heading': _machines,
  'forging_daily_work': _operations,
  'forging_die_care': _tooling,
  'forging_experience': _experience,
  'forging_heating': _machines,
  'forging_level': _level,
  'forging_machine': _machines,
  'forging_part': _operations,
  'forging_senior_confirm': _level,
  'forging_setter_confirm': _level,
  'forging_setting_work': _setting,
  'forging_team_confirm': _level,
  'forging_type': _process,
  // CEO pack v2, Wave 2 (#3016) — same rules: tenure/level/confirms → Experience;
  // sector → Industry; ITI/licence/certificate → Training; machines run → Machines;
  // plant equipment/tanks/lines → Equipment; processes/techniques → Process;
  // daily/scope/parts/products work → Operations; setting → Setting;
  // software/controllers/programs → Programming & software; materials/fuels/chemicals
  // → Material; instruments/masters/test machines → Measuring; tests/standards/records
  // of tests → Quality; defects → Troubleshooting; drawings → Drawing; tools/rigging
  // tackle → Tooling; safety-critical work → Safety; overhaul-type maintenance →
  // Maintenance; capacity/size/tonnage bands → Capability.
  // qp_gear_cutting (T18)
  'gear_calculation': _process,
  'gear_cnc_work': _software,
  'gear_experience': _experience,
  'gear_level': _level,
  'gear_machine_control': _machines,
  'gear_machine_make': _machines,
  'gear_module_range': _capability,
  'gear_process': _process,
  'gear_quality_class': _quality,
  'gear_setter_confirm': _level,
  'gear_setter_programmer_confirm': _level,
  'gear_setting_work': _setting,
  'gear_team_confirm': _level,
  'gear_type': _operations,
  // qp_boring_machine (T19)
  'boring_experience': _experience,
  'boring_job_type': _operations,
  'boring_level': _level,
  'boring_machine_control': _machines,
  'boring_machine_make': _machines,
  'boring_machine_type': _machines,
  'boring_operation': _operations,
  'boring_programming_level': _software,
  'boring_setter_confirm': _level,
  'boring_setter_programmer_confirm': _level,
  'boring_setting_work': _setting,
  'boring_team_confirm': _level,
  // qp_spm_finishing (T20)
  'spm_daily_work': _operations,
  'spm_experience': _experience,
  'spm_finish_control': _precision,
  'spm_level': _level,
  'spm_machine_make': _machines,
  'spm_machine_type': _machines,
  'spm_part_type': _operations,
  'spm_process': _process,
  'spm_senior_confirm': _level,
  'spm_setter_confirm': _level,
  'spm_setting_work': _setting,
  'spm_team_confirm': _level,
  'spm_tooling': _tooling,
  // qp_fabrication (T22)
  'fab_code_standard': _quality,
  'fab_daily_work': _operations,
  'fab_drawing_type': _drawing,
  'fab_experience': _experience,
  'fab_fitup_work': _operations,
  'fab_layout_development': _operations,
  'fab_level': _level,
  'fab_machine_used': _machines,
  'fab_planning_work': _operations,
  'fab_senior_confirm': _level,
  'fab_skilled_confirm': _level,
  'fab_team_confirm': _level,
  'fab_thickness_range': _capability,
  'fab_work_location': _operations,
  'fab_work_type': _operations,
  // qp_tube_forming (T23)
  'tube_bend_capability': _precision,
  'tube_daily_work': _operations,
  'tube_experience': _experience,
  'tube_level': _level,
  'tube_machine_make': _machines,
  'tube_machine_type': _machines,
  'tube_new_part_work': _operations,
  'tube_product': _operations,
  'tube_program_work': _software,
  'tube_senior_confirm': _level,
  'tube_setter_confirm': _level,
  'tube_setting_work': _setting,
  'tube_size_range': _capability,
  'tube_team_confirm': _level,
  'tube_tooling': _tooling,
  // qp_surface_treatment (T28)
  'plating_bath_control': _process,
  'plating_chemical_safety': _material,
  'plating_daily_work': _operations,
  'plating_etp_work': _operations,
  'plating_experience': _experience,
  'plating_level': _level,
  'plating_line_type': _equipment,
  'plating_other_finish': _operations,
  'plating_part': _operations,
  'plating_passivation': _quality,
  'plating_process': _process,
  'plating_rectifier_work': _equipment,
  'plating_senior_confirm': _level,
  'plating_skilled_confirm': _level,
  'plating_team_confirm': _level,
  'plating_testing': _quality,
  // qp_blow_moulding (T30)
  'blow_auxiliary': _equipment,
  'blow_capacity': _capability,
  'blow_daily_work': _operations,
  'blow_experience': _experience,
  'blow_level': _level,
  'blow_machine_brand': _machines,
  'blow_parameter_setting': _process,
  'blow_process_control': _process,
  'blow_process_type': _process,
  'blow_product': _operations,
  'blow_senior_confirm': _level,
  'blow_setter_confirm': _level,
  'blow_setting_work': _setting,
  'blow_team_confirm': _level,
  // qp_plastic_extrusion (T31)
  'extrusion_daily_work': _operations,
  'extrusion_downstream': _equipment,
  'extrusion_experience': _experience,
  'extrusion_extruder_type': _machines,
  'extrusion_lab_tests': _quality,
  'extrusion_level': _level,
  'extrusion_machine_brand': _machines,
  'extrusion_parameter_setting': _process,
  'extrusion_process_control': _process,
  'extrusion_product_line': _operations,
  'extrusion_senior_confirm': _level,
  'extrusion_setter_confirm': _level,
  'extrusion_setting_work': _setting,
  'extrusion_team_confirm': _level,
  // qp_rubber_moulding (T32)
  'rubber_daily_work': _operations,
  'rubber_experience': _experience,
  'rubber_level': _level,
  'rubber_mixing_work': _process,
  'rubber_press_capacity': _capability,
  'rubber_press_type': _machines,
  'rubber_process': _process,
  'rubber_process_control': _process,
  'rubber_product': _operations,
  'rubber_senior_confirm': _level,
  'rubber_setter_confirm': _level,
  'rubber_setting_work': _setting,
  'rubber_team_confirm': _level,
  // qp_ndt (T34)
  'ndt_advanced_method': _process,
  'ndt_certificate_scheme': _training,
  'ndt_certificate_valid': _training,
  'ndt_code_standard': _quality,
  'ndt_defect_types': _trouble,
  'ndt_equipment': _machines,
  'ndt_experience': _experience,
  'ndt_job_type': _operations,
  'ndt_lead_confirm': _level,
  'ndt_level': _level,
  'ndt_level_three_methods': _process,
  'ndt_level_two_methods': _process,
  'ndt_method': _process,
  'ndt_responsibility': _operations,
  'ndt_rt_work': _operations,
  'ndt_senior_technician_confirm': _level,
  'ndt_surface_method': _process,
  'ndt_ut_work': _operations,
  'ndt_work_place': _operations,
  // qp_calibration (T35)
  'calib_experience': _experience,
  'calib_instrument_type': _measuring,
  'calib_lab_type': _operations,
  'calib_level': _level,
  'calib_master_equipment': _measuring,
  'calib_master_make': _measuring,
  'calib_method_standard': _quality,
  'calib_msa_work': _quality,
  'calib_nabl_work': _quality,
  'calib_onsite_work': _operations,
  'calib_parameter': _operations,
  'calib_plant_system': _operations,
  'calib_records': _quality,
  'calib_senior_technician_confirm': _level,
  'calib_team_confirm': _level,
  'calib_uncertainty_work': _quality,
  // qp_material_lab (T36)
  'matlab_chemical_work': _process,
  'matlab_experience': _experience,
  'matlab_failure_analysis': _trouble,
  'matlab_hardness_method': _measuring,
  'matlab_lab_type': _operations,
  'matlab_level': _level,
  'matlab_machine_make': _measuring,
  'matlab_metallography': _process,
  'matlab_nabl_work': _quality,
  'matlab_other_tests': _process,
  'matlab_qualification_branch': _training,
  'matlab_records': _quality,
  'matlab_senior_technician_confirm': _level,
  'matlab_spectro_make': _measuring,
  'matlab_team_confirm': _level,
  'matlab_tensile_work': _process,
  'matlab_test_standard': _quality,
  'matlab_test_type': _process,
  // qp_robotics (T39)
  'robot_application': _operations,
  'robot_brand': _machines,
  'robot_cell_equipment': _equipment,
  'robot_daily_work': _operations,
  'robot_experience': _experience,
  'robot_level': _level,
  'robot_maintenance': _overhaul,
  'robot_offline_software': _software,
  'robot_part_type': _operations,
  'robot_plc_interface': _software,
  'robot_program_work': _software,
  'robot_programmer_confirm': _level,
  'robot_senior_confirm': _level,
  'robot_teaching_work': _software,
  'robot_team_confirm': _level,
  'robot_weld_parameters': _process,
  // qp_instrumentation (T40)
  'instr_advanced_work': _operations,
  'instr_brand': _measuring,
  'instr_calibration_tools': _measuring,
  'instr_control_system': _software,
  'instr_dcs_brand': _software,
  'instr_dcs_work': _software,
  'instr_drawing_reading': _drawing,
  'instr_experience': _experience,
  'instr_hazardous_area': _safety,
  'instr_instrument_type': _measuring,
  'instr_level': _level,
  'instr_senior_technician_confirm': _level,
  'instr_team_confirm': _level,
  'instr_trade_certificate': _training,
  'instr_valve_work': _operations,
  'instr_work_type': _operations,
  // qp_hvac_rac (T41)
  'hvac_ammonia_work': _safety,
  'hvac_brand': _machines,
  'hvac_capacity': _capability,
  'hvac_cleanroom_work': _operations,
  'hvac_compressor_type': _equipment,
  'hvac_electrical_controls': _software,
  'hvac_experience': _experience,
  'hvac_level': _level,
  'hvac_plant_work': _operations,
  'hvac_refrigerant': _material,
  'hvac_senior_technician_confirm': _level,
  'hvac_site_handling': _operations,
  'hvac_system_type': _operations,
  'hvac_team_confirm': _level,
  'hvac_tools': _tooling,
  'hvac_trade_certificate': _training,
  'hvac_work_type': _operations,
  // qp_utility (T42)
  'utility_boiler_capacity': _capability,
  'utility_boiler_certificate': _training,
  'utility_boiler_fuel': _material,
  'utility_boiler_make': _machines,
  'utility_boiler_work': _operations,
  'utility_compressor_make': _machines,
  'utility_compressor_type': _equipment,
  'utility_daily_work': _operations,
  'utility_dg_work': _operations,
  'utility_experience': _experience,
  'utility_level': _level,
  'utility_plant_type': _operations,
  'utility_records_planning': _operations,
  'utility_senior_confirm': _level,
  'utility_skilled_confirm': _level,
  'utility_team_confirm': _level,
  'utility_water_plant': _operations,
  'utility_water_work': _operations,
  // qp_forklift (T56)
  'forklift_attachment': _tooling,
  'forklift_capacity': _capability,
  'forklift_daily_check': _operations,
  'forklift_equipment': _machines,
  'forklift_experience': _experience,
  'forklift_level': _level,
  'forklift_licence': _training,
  'forklift_load_type': _operations,
  'forklift_make': _machines,
  'forklift_operator_confirm': _level,
  'forklift_power_type': _operations,
  'forklift_rack_height': _operations,
  'forklift_safety_work': _safety,
  'forklift_senior_confirm': _level,
  'forklift_team_confirm': _level,
  'forklift_training_certificate': _training,
  'forklift_work_area': _operations,
  'forklift_work_done': _operations,
  // qp_crane_rigging (T57)
  'crane_capacity': _capability,
  'crane_control_type': _machines,
  'crane_daily_check': _operations,
  'crane_experience': _experience,
  'crane_level': _level,
  'crane_licence_certificate': _training,
  'crane_lifting_tackle': _tooling,
  'crane_load_type': _operations,
  'crane_make': _machines,
  'crane_operator_confirm': _level,
  'crane_rigging_work': _operations,
  'crane_role': _operations,
  'crane_safety_work': _safety,
  'crane_senior_confirm': _level,
  'crane_special_lift': _operations,
  'crane_tackle_certificate': _training,
  'crane_team_confirm': _level,
  'crane_type': _machines,
  // CEO pack v2, Wave 3 (#3017) — same rules as Wave 2.
  // qp_service_engineer
  'service_brand_handled': _operations,
  'service_call_closing': _operations,
  'service_customer_business': _operations,
  'service_employer_type': _operations,
  'service_equipment': _machines,
  'service_experience': _experience,
  'service_installation_scope': _operations,
  'service_lead_confirm': _level,
  'service_level': _level,
  'service_machine_tool_work': _machines,
  'service_qualification_branch': _training,
  'service_senior_engineer_confirm': _level,
  'service_team_confirm': _level,
  'service_technical_area': _operations,
  'service_training_exposure': _training,
  'service_travel_region': _operations,
  'service_vehicle_licence': _training,
  'service_work_type': _operations,
  // qp_safety_ehs
  'ehs_daily_work': _safety,
  'ehs_documents_owned': _safety,
  'ehs_engineer_confirm': _level,
  'ehs_environment_work': _safety,
  'ehs_experience': _experience,
  'ehs_extra_certificate': _training,
  'ehs_fire_system': _safety,
  'ehs_hazard_handled': _safety,
  'ehs_incident_work': _safety,
  'ehs_lead_confirm': _level,
  'ehs_level': _level,
  'ehs_permit_types': _safety,
  'ehs_qualification_branch': _training,
  'ehs_senior_engineer_confirm': _level,
  'ehs_site_type': _safety,
  'ehs_standards': _safety,
  'ehs_statutory_work': _safety,
  'ehs_strength_handled': _safety,
  'ehs_team_confirm': _level,
  'ehs_training_exposure': _training,
  // qp_project_site
  'site_billing_work': _operations,
  'site_commissioning_work': _operations,
  'site_daily_work': _operations,
  'site_drawings_read': _drawing,
  'site_employer_type': _operations,
  'site_erection_work': _operations,
  'site_experience': _experience,
  'site_lead_confirm': _level,
  'site_level': _level,
  'site_location_worked': _operations,
  'site_planning_work': _operations,
  'site_project_type': _operations,
  'site_project_value': _operations,
  'site_qualification_branch': _training,
  'site_quality_docs': _operations,
  'site_senior_engineer_confirm': _level,
  'site_software': _software,
  'site_team_confirm': _level,
  'site_training_exposure': _training,
  // qp_technical_sales
  'sales_application_work': _operations,
  'sales_commercial_work': _operations,
  'sales_employer_type': _operations,
  'sales_experience': _experience,
  'sales_key_account_work': _operations,
  'sales_lead_confirm': _level,
  'sales_level': _level,
  'sales_product_line': _operations,
  'sales_qualification_branch': _training,
  'sales_senior_engineer_confirm': _level,
  'sales_target_size': _operations,
  'sales_team_confirm': _level,
  'sales_team_work': _operations,
  'sales_territory': _operations,
  'sales_tools_used': _operations,
  'sales_training_exposure': _training,
  'sales_vehicle': _machines,
  'sales_work_type': _operations,
  // qp_stores
  'store_computer_skill': _software,
  'store_daily_work': _operations,
  'store_documents': _operations,
  'store_erp_system': _software,
  'store_experience': _experience,
  'store_gst_documents': _operations,
  'store_handling_equipment': _machines,
  'store_item_count': _operations,
  'store_level': _level,
  'store_material_handled': _material,
  'store_qualification_branch': _training,
  'store_rejection_scrap': _operations,
  'store_senior_executive_confirm': _level,
  'store_stock_audit': _operations,
  'store_stock_control': _operations,
  'store_system_work': _operations,
  'store_team_confirm': _level,
  'store_training_exposure': _training,
  'store_type': _operations,
  // qp_dispatch_logistics
  'dispatch_customer_portal': _operations,
  'dispatch_customer_type': _operations,
  'dispatch_daily_volume': _operations,
  'dispatch_documents': _operations,
  'dispatch_erp_system': _software,
  'dispatch_experience': _experience,
  'dispatch_export_work': _operations,
  'dispatch_function': _operations,
  'dispatch_improvement_work': _operations,
  'dispatch_kpi_reporting': _operations,
  'dispatch_level': _level,
  'dispatch_loading_plan': _operations,
  'dispatch_packing_work': _operations,
  'dispatch_qualification_branch': _training,
  'dispatch_senior_executive_confirm': _level,
  'dispatch_team_confirm': _level,
  'dispatch_training_exposure': _training,
  'dispatch_vehicle_mode': _machines,
  'dispatch_warehouse_system': _operations,
  // qp_cae_fea
  'cae_component': _operations,
  'cae_domain': _operations,
  'cae_employer_type': _operations,
  'cae_experience': _experience,
  'cae_lead_confirm': _level,
  'cae_level': _level,
  'cae_model_checks': _operations,
  'cae_optimisation': _operations,
  'cae_preprocessor': _software,
  'cae_process_sim_software': _software,
  'cae_project_ownership': _operations,
  'cae_qualification_branch': _training,
  'cae_scripting': _operations,
  'cae_senior_engineer_confirm': _level,
  'cae_solver': _software,
  'cae_standards': _operations,
  'cae_team_confirm': _level,
  'cae_test_correlation': _operations,
  'cae_training_exposure': _training,
  'cae_work_stage': _operations,
  // qp_piping_design
  'piping_admin_work': _operations,
  'piping_checking_work': _operations,
  'piping_codes': _operations,
  'piping_deliverables': _operations,
  'piping_employer_type': _operations,
  'piping_equipment_area': _machines,
  'piping_experience': _experience,
  'piping_lead_confirm': _level,
  'piping_level': _level,
  'piping_model_work': _operations,
  'piping_qualification_branch': _training,
  'piping_senior_designer_confirm': _level,
  'piping_site_exposure': _operations,
  'piping_software': _software,
  'piping_stress_exposure': _operations,
  'piping_support_work': _operations,
  'piping_team_confirm': _level,
  'piping_training_exposure': _training,
  // shared
  'iti_project_work': _operations,
};

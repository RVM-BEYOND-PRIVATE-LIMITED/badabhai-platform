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
  'coating_level': _level,
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
  // Welding / coating process
  'welding_process': _process, 'coating_process': _process,
  'surface_prep': _process, 'oven_schedule': _process,
  'joint_type': ('Welding', 'Joints & positions'),
  'welding_position': ('Welding', 'Joints & positions'),
  'electrode_type': ('Welding', 'Consumables'),
  'plate_thickness': ('Welding', 'Plate thickness'),
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
  'sheet_metal_machine': _machines,
  'sheet_operation': ('Sheet metal operations', 'Operations & capability'),
  'sheet_thickness': ('Sheet metal operations', 'Sheet thickness'),
  'assembly_finishing': ('Sheet metal operations', 'Assembly & finishing'),
  'press_brake_setting': _changeover,
  'layout_calculation': ('Drawing & design', 'Layout & flat pattern'),
  'nesting_software': _software,
  // Press operation (qp_press_operation)
  'press_experience': _experience, 'press_level': _level,
  'press_machine': _machines, 'press_stroke_rate': _capability,
  'press_setting': _changeover, 'press_die_type': _tooling,
  'press_safety': _safety, 'press_defect': _trouble,
  'press_maintenance': ('Maintenance', 'Machine upkeep'),
  // Fitter (qp_fitter)
  'fitting_experience': _experience, 'fitter_level': _level,
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
  'maintenance_fault_finding': _trouble,
  // Industrial electrician (qp_industrial_electrician)
  'electrical_experience': _experience, 'electrician_level': _level,
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
  'assembly_stage': ('Assembly operations', 'Line stages'),
  'assembly_line_product': ('Assembly operations', 'Assemblies worked on'),
  'assembly_joining': ('Assembly operations', 'Joining work'),
  'assembly_takt_time': ('Assembly operations', 'Takt time'),
  'assembly_station_count': ('Assembly operations', 'Stations handled'),
  'assembly_responsibility': ('Assembly operations', 'Line responsibilities'),
  'assembly_practice': ('Assembly operations', 'Shop-floor practice'),
  'assembly_tool': ('Tooling & fixtures', 'Hand & power tools'),
  'assembly_defect': _trouble,
  // Quality inspection (qp_quality_inspection)
  'inspection_experience': _experience, 'inspection_level': _level,
  'inspection_stage': ('Quality & inspection', 'Inspection stages'),
  'inspection_least_count': ('Quality & inspection', 'Least count'),
  'inspection_standard': ('Quality & inspection', 'Quality standards'),
  'inspection_documentation': ('Quality & inspection', 'Quality documents'),
  'inspection_cmm_work': ('Quality & inspection', 'CMM work'),
  'inspection_rejection_work': ('Quality & inspection', 'Rejection handling'),
  'inspection_audit_work': ('Quality & inspection', 'Audits & customers'),
};

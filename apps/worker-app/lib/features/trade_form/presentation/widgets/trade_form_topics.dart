/// The two labels the form-flow mockups print around each question: the
/// CATEGORY after the step in the header ("STEP 5 OF 6 • TOOLING & FIXTURES")
/// and the TOPIC on the white progress strip ("CLAMPING & WORKHOLDING").
///
/// Packs carry no grouping field, so these come from the question's own
/// `question_key` — every key the nine form trades ship is listed, and an
/// unknown key (a new pack version) falls back to its own words, readable, so
/// nothing is ever blank or invented.
library;

/// (category, topic) for [questionKey].
(String, String) formTopicFor(String questionKey) {
  final (String, String)? known = _kTopics[questionKey];
  if (known != null) return known;
  final String words = _readable(questionKey);
  return (words, words);
}

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
};

import 'package:flutter/material.dart';

import 'form_glyphs.dart';

/// The icon tile drawn on every form option card (Workholding / Measuring /
/// Operations mockups).
///
/// ── WHY RULES, NOT A LIST OF KEYS ───────────────────────────────────────────
///
/// Options are SERVER data: 1,642 of them across the question packs, carrying
/// only `option_key` and `label_text` — no icon field. A per-key table would be
/// out of date the day a pack version adds an option. So the icon is derived
/// from the words the option itself uses (label + key), most specific rule
/// first, then from the question it belongs to, then a neutral default. Every
/// card always gets an icon, and a new option in any trade gets a sensible one
/// without a client release.
///
/// ── THE MOCKUP'S OWN OPTIONS DRAW THE MOCKUP'S OWN GLYPHS ───────────────────
///
/// The 18 options the Workholding / Measuring / Operations mockups draw — teen
/// jaw, chaar jaw, collet, soft jaw, tailstock, steady rest; vernier,
/// micrometer, bore dial gauge, height gauge, plug/ring gauge, dial indicator;
/// facing/OD, boring/ID, threading, grooving/parting, drilling/tapping,
/// knurling/taper — resolve to [FormGlyphs]: thin-stroke outlines traced from
/// the mockup into the bundled `BbFormGlyphs` icon font. They are matched by
/// the same word rules as every other option (so "Micrometer (Outside /
/// Inside)" or a renamed key still finds its glyph), just drawn from that font.
/// Every other option keeps its Material icon.
IconData iconForOption({
  required String optionKey,
  required String label,
  String? questionKey,
}) {
  final String text = ' ${label.toLowerCase()} ${optionKey.toLowerCase().replaceAll('_', ' ')} ';
  for (final _IconRule rule in _optionRules) {
    if (rule.pattern.hasMatch(text)) return rule.icon;
  }
  return iconForQuestion(questionKey);
}

/// The icon for a question as a whole — the fallback for an option no rule
/// recognises, and usable for a page heading.
IconData iconForQuestion(String? questionKey) {
  final String key = ' ${(questionKey ?? '').toLowerCase().replaceAll('_', ' ')} ';
  for (final _IconRule rule in _questionRules) {
    if (rule.pattern.hasMatch(key)) return rule.icon;
  }
  return Icons.label_outline_rounded;
}

class _IconRule {
  _IconRule(String words, this.icon)
      : pattern = RegExp('(?:^|[^a-z0-9])(?:$words)', caseSensitive: false);

  final RegExp pattern;
  final IconData icon;
}

// Ordered: the first match wins, so specific phrases sit above generic words.
final List<_IconRule> _optionRules = <_IconRule>[
  // Fallback choices first — "Inme se koi nahi" must not read as a machine.
  _IconRule(r'pata nahi|unknown|yaad nahi', Icons.help_outline_rounded),
  _IconRule(r'inme se koi nahi|in me se koi nahi|koi aur|none of|other', Icons.more_horiz_rounded),
  // Workholding (mockup 15 glyphs)
  _IconRule(r'teen jaw|three jaw|3 jaw', FormGlyphs.teenJawChuck),
  _IconRule(r'chaar jaw|four jaw|4 jaw', FormGlyphs.chaarJawChuck),
  _IconRule(r'collet', FormGlyphs.collet),
  _IconRule(r'soft jaw', FormGlyphs.softJaw),
  _IconRule(r'tailstock', FormGlyphs.tailstockCentre),
  _IconRule(r'steady rest', FormGlyphs.steadyRest),
  _IconRule(r'magnetic', Icons.hub_outlined),
  _IconRule(r'vice|clamp', Icons.compress_rounded),
  _IconRule(r'jig|fixture', Icons.construction_rounded),
  _IconRule(r'fit-up|fit up|tacking', Icons.construction_rounded),
  _IconRule(r'rotary table|indexer', Icons.rotate_right_rounded),
  _IconRule(r'angle plate|sine bar', Icons.square_foot_rounded),
  _IconRule(r'profile projector', Icons.center_focus_strong_outlined),
  _IconRule(r'live tooling|sub spindle|bar feeder|c axis|y axis', Icons.precision_manufacturing_outlined),
  _IconRule(r'furnace|heat treatment|hardness', Icons.local_fire_department_outlined),
  _IconRule(r'marking|scribing', Icons.edit_outlined),
  _IconRule(r'tool length|tool change|tool loading|tool ki height|chuck ya jaw badalna', Icons.tune_rounded),
  _IconRule(r'hss|sharpen|regrind|dhaar', Icons.build_outlined),
  _IconRule(r'strip layout|strip jam|misfeed|shut height|shut-height|tryout|benchwork|scraping', Icons.handyman_outlined),
  _IconRule(r'dimension|revision|projection|2d drafting', Icons.description_outlined),
  _IconRule(r'belt|gear badal|bearing|fastener|transmission|gear', Icons.settings_rounded),
  _IconRule(r'studer', Icons.memory_rounded),
  _IconRule(r'video|khud seekha', Icons.ondemand_video_outlined),
  _IconRule(r'alignment', Icons.align_horizontal_center_rounded),
  _IconRule(r'weight|cost', Icons.calculate_outlined),
  _IconRule(r'dono|both', Icons.done_all_rounded),
  // Measuring instruments
  _IconRule(r'vernier|caliper', FormGlyphs.vernierCaliper),
  _IconRule(r'micrometer', FormGlyphs.micrometer),
  _IconRule(r'bore dial', FormGlyphs.boreDialGauge),
  _IconRule(r'height gauge', FormGlyphs.heightGauge),
  _IconRule(r'plug|ring gauge', FormGlyphs.plugRingGauge),
  _IconRule(r'dial indicator|dial', FormGlyphs.dialIndicator),
  _IconRule(r'slip gauge', Icons.view_week_outlined),
  _IconRule(r'cmm', Icons.view_in_ar_outlined),
  _IconRule(r'dft|gloss meter|thickness gauge', Icons.speed_outlined),
  _IconRule(r'gauge', Icons.speed_outlined),
  // Operations (mockup 14 glyphs)
  _IconRule(r'facing|od turning|turning aur facing', FormGlyphs.facingOdTurning),
  _IconRule(r'boring|id turning|internal', FormGlyphs.boringIdTurning),
  _IconRule(r'thread|screw cutting', FormGlyphs.threading),
  _IconRule(r'groov|parting|slot', FormGlyphs.groovingParting),
  _IconRule(r'drill|tapping', FormGlyphs.drillingTapping),
  _IconRule(r'knurl|taper', FormGlyphs.knurlingTaper),
  _IconRule(r'gear cutting|dividing head', Icons.settings_rounded),
  _IconRule(r'toolpath|multi-axis|5-axis|4-axis|3-axis|axis', Icons.open_with_rounded),
  // Grinding / EDM
  _IconRule(r'dressing|diamond', Icons.diamond_outlined),
  _IconRule(r'wheel|grind|cbn|carbide|oxide', Icons.blur_circular_rounded),
  _IconRule(r'edm|wire-cut|wire cut|spark|electrode banana', Icons.flash_on_rounded),
  // Welding
  _IconRule(r'1g|2g|3g|4g|5g|6g|flat|horizontal|overhead|vertical up', Icons.open_with_rounded),
  _IconRule(r'butt|fillet|lap joint|corner joint|joint', Icons.join_inner_outlined),
  _IconRule(r'e6013|e7018|er70|rod|wire|electrode', Icons.linear_scale_rounded),
  _IconRule(r'mig|mag|tig|arc|weld|co2|inverter', Icons.local_fire_department_outlined),
  _IconRule(r'gas cutting|gouging|oxy', Icons.whatshot_outlined),
  _IconRule(r'porosity|undercut|spatter|blister|pinhole|orange peel|burr|defect|crack|tedhi', Icons.report_problem_outlined),
  // Coating
  _IconRule(r'oven|curing|degree', Icons.thermostat_rounded),
  _IconRule(r'degreas|phosphat|blast|sanding|rubbing', Icons.cleaning_services_outlined),
  _IconRule(r'filter|cyclone|reclaim|hopper', Icons.filter_alt_outlined),
  _IconRule(r'booth|conveyor', Icons.meeting_room_outlined),
  _IconRule(r'powder|coating|spray|paint|primer|epoxy|polyester|gun|nozzle', Icons.format_paint_outlined),
  // Machines & controllers
  _IconRule(r'fanuc|siemens|mitsubishi|haas|heidenhain|mazak|controller', Icons.memory_rounded),
  _IconRule(r'spm|special purpose', Icons.settings_suggest_outlined),
  _IconRule(r'press tool|progressive die|die|punch|mould|tool room|toolroom', Icons.handyman_outlined),
  _IconRule(r'press|tonnage|\d+ ton', Icons.compress_rounded),
  _IconRule(r'lathe|khraad|vtl|turning centre|sliding head|swiss|vmc|hmc|cnc|machining centre|milling machine|mill|machine|shaper|planer|turn-mill', Icons.precision_manufacturing_outlined),
  // Programming & CAD
  _IconRule(r'vericut|simulation|collision', Icons.play_circle_outline_rounded),
  _IconRule(r'autocad|solidworks|creo|pro-e|catia|fusion|nx|cad|model|step|iges|parasolid|assembly mating', Icons.architecture_rounded),
  _IconRule(r'mastercam|powermill|solidcam|edgecam|cam|post|program|offset|mdi|g code|g-code|macro', Icons.code_rounded),
  _IconRule(r'drawing|gd aur t|gdt|blueprint|bom|title block|dxf|section|sketch', Icons.description_outlined),
  // Materials
  _IconRule(r'steel|aluminium|brass|copper|iron|metal|alloy|titanium|plastic|en8|en31|ohns|hchcr|d2|galvan|sheet', Icons.layers_outlined),
  // Precision
  _IconRule(r'tolerance|micron|\d+ ?mm|ra \d', Icons.straighten_rounded),
  // Sectors
  _IconRule(r'automobile|automotive|auto part|auto', Icons.directions_car_outlined),
  _IconRule(r'aerospace|aircraft', Icons.flight_outlined),
  _IconRule(r'defence|defense', Icons.shield_outlined),
  _IconRule(r'agri|tractor', Icons.agriculture_outlined),
  _IconRule(r'pump|valve|hydraulic|coolant', Icons.water_drop_outlined),
  _IconRule(r'oil|gas', Icons.local_gas_station_outlined),
  _IconRule(r'electric|electronic|wiring', Icons.electrical_services_outlined),
  _IconRule(r'white goods|appliance', Icons.kitchen_outlined),
  _IconRule(r'engineering|job shop|fabrication|general', Icons.factory_outlined),
  // Quality & troubleshooting
  _IconRule(r'chatter|vibration', Icons.vibration_rounded),
  _IconRule(r'alarm', Icons.notifications_active_outlined),
  _IconRule(r'toot|ghisna|breakage|wear', Icons.build_circle_outlined),
  _IconRule(r'first piece|pehla piece|spc|rejection|inspection|visual|check|quality|test|x-ray|dpt', Icons.fact_check_outlined),
  _IconRule(r'surface finish|finish|size', Icons.auto_awesome_outlined),
  // People, training, experience
  _IconRule(r'iti|diploma|course|college|institute|training', Icons.school_outlined),
  _IconRule(r'pass|result|certified|certificate', Icons.verified_outlined),
  _IconRule(r'helper|operator|skilled|senior|trainee|maker|welder|painter', Icons.person_outline_rounded),
  _IconRule(r'saal|year|month', Icons.schedule_rounded),
  // Yes / no
  _IconRule(r'haan|yes', Icons.check_circle_outline_rounded),
  _IconRule(r'nahi|no', Icons.remove_circle_outline_rounded),
];

final List<_IconRule> _questionRules = <_IconRule>[
  _IconRule(r'experience', Icons.schedule_rounded),
  _IconRule(r'level', Icons.person_outline_rounded),
  _IconRule(r'controller', Icons.memory_rounded),
  _IconRule(r'workholding', Icons.gps_fixed_rounded),
  _IconRule(r'measuring', Icons.straighten_rounded),
  _IconRule(r'operation', Icons.segment_rounded),
  _IconRule(r'machine|equipment|booth|capacity|axis|advanced', Icons.precision_manufacturing_outlined),
  _IconRule(r'material|substrate|steel', Icons.layers_outlined),
  _IconRule(r'drawing|design|output', Icons.description_outlined),
  _IconRule(r'cad', Icons.architecture_rounded),
  _IconRule(r'cam|program|post|simulation', Icons.code_rounded),
  _IconRule(r'setting|dressing|gun|colour', Icons.tune_rounded),
  _IconRule(r'tolerance|finish|thickness', Icons.straighten_rounded),
  _IconRule(r'quality|check|inspection', Icons.fact_check_outlined),
  _IconRule(r'troubleshooting|defect', Icons.build_circle_outlined),
  _IconRule(r'sector', Icons.factory_outlined),
  _IconRule(r'weld|joint|electrode|position|plate', Icons.local_fire_department_outlined),
  _IconRule(r'coating|surface prep|oven', Icons.format_paint_outlined),
  _IconRule(r'press|tonnage', Icons.compress_rounded),
  _IconRule(r'die|tool', Icons.handyman_outlined),
  _IconRule(r'wheel|grinding', Icons.blur_circular_rounded),
  _IconRule(r'edm', Icons.flash_on_rounded),
  _IconRule(r'iti|training|trade test', Icons.school_outlined),
];

// ---- the work-preference lists both form walks ask ----
//
// The trade form's preferences marker and the finishing form show the SAME
// server lists (documents ready, shift, job type). The rules above are tuned
// for trade question packs — "General" reads as a factory, "Pass" as a result
// — so on these lists they would draw a factory beside "General shift". These
// match the lists' own words first. Both walks call them, so one option draws
// one glyph whichever walk shows it. Display only: a slug no rule recognises
// still gets the list's own icon, never a missing one.

/// A document card: a glyph per known document, else the shared option rules,
/// else a generic ID card.
IconData documentOptionIcon(String optionKey, String label) {
  final IconData? own = _firstWordMatch(_documentRules, optionKey, label);
  if (own != null) return own;
  final IconData shared = iconForOption(optionKey: optionKey, label: label);
  return shared == iconForQuestion(null) ? Icons.badge_outlined : shared;
}

/// A shift card.
IconData shiftOptionIcon(String optionKey, String label) =>
    _firstWordMatch(_shiftRules, optionKey, label) ?? Icons.schedule_rounded;

/// A job-type card.
IconData jobTypeOptionIcon(String optionKey, String label) =>
    _firstWordMatch(_jobTypeRules, optionKey, label) ??
    Icons.work_outline_rounded;

IconData? _firstWordMatch(
  List<(RegExp, IconData)> rules,
  String optionKey,
  String label,
) {
  final String text = '${optionKey.replaceAll('_', ' ')} $label'.toLowerCase();
  for (final (RegExp pattern, IconData icon) in rules) {
    if (pattern.hasMatch(text)) return icon;
  }
  return null;
}

RegExp _words(String alternatives) => RegExp('\\b(?:$alternatives)');

// Ordered: first match wins.
final List<(RegExp, IconData)> _documentRules = <(RegExp, IconData)>[
  (_words('aadhaar|aadhar'), Icons.fingerprint_rounded),
  (_words('pan'), Icons.credit_card_rounded),
  (_words('bank'), Icons.account_balance_outlined),
  (_words('uan|pf|provident'), Icons.savings_outlined),
  (_words('esic|esi'), Icons.health_and_safety_outlined),
  (_words('iti|certificate'), Icons.school_outlined),
  (_words('experience|letter'), Icons.description_outlined),
  (_words('passport|photo'), Icons.portrait_outlined),
  (_words('driving|licen'), Icons.directions_car_outlined),
];

final List<(RegExp, IconData)> _shiftRules = <(RegExp, IconData)>[
  (_words('night'), Icons.nightlight_outlined),
  (_words('day'), Icons.wb_sunny_outlined),
  (_words('rotat'), Icons.sync_rounded),
];

final List<(RegExp, IconData)> _jobTypeRules = <(RegExp, IconData)>[
  (_words('permanent'), Icons.work_outline_rounded),
  (_words('contract'), Icons.assignment_outlined),
  (_words('apprentic'), Icons.school_outlined),
  (_words('daily|wage'), Icons.today_outlined),
];

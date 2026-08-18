/// Taxonomy ID → display label resolver.
///
/// Mirrors the canonical TS taxonomy in `packages/taxonomy/src/index.ts` and
/// `packages/taxonomy/src/skill-corpus.ts`. Built as a static lookup so any
/// text (AI-generated resume, profile fields) that accidentally carries raw
/// taxonomy IDs instead of labels can be cleaned up client-side.
///
/// PII-FREE: taxonomy IDs are opaque code strings, never worker data.
library;

const Map<String, String> _kRoleLabels = {
  'role_cnc_turner_operator': 'CNC Turner/Operator',
  'role_vmc_operator': 'VMC Operator',
  'role_hmc_operator': 'HMC Operator',
  'role_cnc_setter_operator': 'CNC Setter-Operator',
  'role_cnc_programmer': 'CNC Programmer',
  'role_cam_programmer': 'CAM Programmer',
  'role_cnc_grinding_operator': 'CNC Grinding Operator',
  'role_welder': 'Welder',
  'role_cnc_operator': 'CNC Operator',
};

const Map<String, String> _kMachineLabels = {
  'mach_cnc_lathe': 'CNC Lathe / Turning Center',
  'mach_vmc': 'Vertical Machining Center (VMC)',
  'mach_hmc': 'Horizontal Machining Center (HMC)',
  'mach_cnc_grinder': 'CNC Grinder',
  'mach_cylindrical_grinder': 'Cylindrical Grinder',
};

const Map<String, String> _kSkillLabels = {
  'skill_gdt_reading': 'GD&T / drawing reading',
  'skill_tool_offset_setting': 'Tool offset setting',
  'skill_program_editing': 'Program editing (G & M codes)',
  'skill_fanuc': 'Fanuc control operation',
  'skill_siemens': 'Siemens control operation',
  'skill_mitsubishi': 'Mitsubishi control operation',
  'skill_measuring_instruments': 'Micrometer / Vernier / gauge usage',
  'skill_fixture_setup': 'Fixture / job setup',
  'skill_cam_software': 'CAM software (Mastercam/Fusion/etc.)',
  'skill_turning': 'Turning (lathe operation)',
  'skill_milling': 'Milling',
  'skill_drilling': 'Drilling',
  'skill_tapping_threading': 'Tapping / threading',
  'skill_grinding_ops': 'Grinding (surface / cylindrical)',
  'skill_deburring': 'Deburring / finishing',
  'skill_cnc_programming': 'CNC programming',
  'skill_cad_interpretation': 'CAD / technical drawing interpretation',
  'skill_cmm': 'CMM operation',
  'skill_quality_control': 'Quality control (QC)',
  'skill_mig_welding': 'MIG welding',
  'skill_tig_welding': 'TIG welding',
  'skill_arc_welding': 'Arc welding',
  'skill_gas_cutting': 'Gas cutting',
  'skill_sheet_metal': 'Sheet-metal fabrication',
  'skill_bench_fitting': 'Bench fitting',
  'skill_mechanical_assembly': 'Mechanical assembly',
  'skill_hydraulics_pneumatics': 'Hydraulics / pneumatics',
  'skill_machine_maintenance': 'Machine maintenance',
  'skill_machinist_occupation': 'Machinist (machine tool operator)',
  'skill_welder_occupation': 'Welder',
  'skill_fitter_occupation': 'Fitter',
};

const Map<String, String> _kDomainLabels = {
  'dom_cnc_machining': 'CNC Machining',
  'dom_vmc_machining': 'VMC Machining',
  'dom_hmc_machining': 'HMC Machining',
  'dom_grinding': 'Grinding',
  'dom_programming': 'CNC/CAM Programming',
  'dom_welding': 'Welding',
};

const Map<String, String> _kIndustryLabels = {
  'ind_industrial_manufacturing': 'Industrial Manufacturing',
};

final Map<String, String> _allLabels = <String, String>{
  ..._kRoleLabels,
  ..._kMachineLabels,
  ..._kSkillLabels,
  ..._kDomainLabels,
  ..._kIndustryLabels,
};

final RegExp _idPrefixPattern = RegExp(r'^(role|skill|mach|dom|ind|trade|ctrl)_');

final Set<String> _acronyms = <String>{
  'cnc', 'vmc', 'hmc', 'iti', 'mig', 'tig', 'gdt', 'cam', 'ncvt', 'nsqf',
  'scvt', 'gtaw', 'gmaw', 'smaw', 'gd&t', 'hvac', 'plc', 'vfd',
};

/// Resolve a single taxonomy ID to its display label.
///
/// Returns the label if known, otherwise prettifies the ID (strips prefix,
/// title-cases, uppercase acronyms). If the input is not ID-shaped (no known
/// prefix), returns it unchanged.
String taxonomyLabel(String id) {
  final String trimmed = id.trim();
  final String? known = _allLabels[trimmed];
  if (known != null) return known;
  if (!_idPrefixPattern.hasMatch(trimmed)) return id;
  return _prettify(trimmed);
}

/// Replace all known taxonomy IDs in [text] with their display labels.
///
/// Matches whole-word taxonomy IDs (role_*, mach_*, skill_*, dom_*, ind_*,
/// trade_*, ctrl_*) by word boundary so partial matches inside longer words
/// are not replaced. Unknown ID-shaped tokens are prettified as a fallback.
String replaceTaxonomyIds(String text) {
  if (text.isEmpty) return text;

  return text.replaceAllMapped(
    RegExp(r'\b(role|skill|mach|dom|ind|trade|ctrl)_[a-z][a-z0-9_]+\b'),
    (Match m) {
      final String word = m.group(0)!;
      final String? known = _allLabels[word];
      if (known != null) return known;
      return _prettify(word);
    },
  );
}

String _prettify(String id) {
  final String stripped = id.replaceFirst(_idPrefixPattern, '');
  return stripped
      .split(RegExp(r'[_\s]+'))
      .where((w) => w.isNotEmpty)
      .map((w) => _acronyms.contains(w.toLowerCase())
          ? w.toUpperCase()
          : '${w[0].toUpperCase()}${w.substring(1)}')
      .join(' ');
}

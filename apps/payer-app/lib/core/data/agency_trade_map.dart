/// The explicit role_kind -> trade_key map for the agency posting route.
///
/// The agency form shows ONE picker over the 16-trade posting catalogue
/// (#2718). The wire still needs `trade_key` (the 15-key agency enum), so it
/// is derived here from the picked role — never typed or defaulted. Every
/// catalogue role has exactly one entry, and every value is a
/// `kAgencyTradeKeys` member; the map is the only place either client may
/// derive it.
const Map<String, String> kAgencyTradeKeyByRoleKind = <String, String>{
  'cnc_turner': 'cnc_operator',
  'vmc_milling': 'vmc_operator',
  'cnc_grinding': 'cnc_operator',
  'cam_programmer': 'cnc_programmer',
  'cad_draughtsman': 'autocad_draftsman',
  'conventional_machinist': 'machine_operator',
  'tool_die_maker': 'tool_room_technician',
  'welder': 'machine_operator',
  'sheet_metal_worker': 'machine_operator',
  'press_operator': 'machine_operator',
  'painter_coating': 'machine_operator',
  'fitter': 'fitter',
  'maintenance_technician': 'maintenance_technician',
  'industrial_electrician': 'maintenance_technician',
  'assembly_line_worker': 'assembly_technician',
  'quality_inspector': 'quality_inspector',
};

/// The `trade_key` for a picked catalogue role, or null when none is picked.
String? agencyTradeKeyForRoleKind(String? roleKind) =>
    roleKind == null ? null : kAgencyTradeKeyByRoleKind[roleKind];

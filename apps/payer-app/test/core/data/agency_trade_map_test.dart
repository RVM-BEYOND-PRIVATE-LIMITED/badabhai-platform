import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/data/agency_trade_map.dart';
import 'package:payer_app/core/data/models.dart';

void main() {
  const List<String> postingTradeKinds = <String>[
    'cnc_turner',
    'vmc_milling',
    'cnc_grinding',
    'cam_programmer',
    'cad_draughtsman',
    'conventional_machinist',
    'tool_die_maker',
    'welder',
    'sheet_metal_worker',
    'press_operator',
    'painter_coating',
    'fitter',
    'maintenance_technician',
    'industrial_electrician',
    'assembly_line_worker',
    'quality_inspector',
  ];

  test('the map covers exactly the 16 catalogue roles', () {
    expect(kAgencyTradeKeyByRoleKind.keys.toSet(), postingTradeKinds.toSet());
    expect(kAgencyTradeKeyByRoleKind, hasLength(16));
  });

  test('every derived trade_key is one of the 15 agency keys', () {
    for (final String tradeKey in kAgencyTradeKeyByRoleKind.values) {
      expect(kAgencyTradeKeys, contains(tradeKey));
    }
  });

  test('the ratified mapping', () {
    expect(agencyTradeKeyForRoleKind('cnc_turner'), 'cnc_operator');
    expect(agencyTradeKeyForRoleKind('vmc_milling'), 'vmc_operator');
    expect(agencyTradeKeyForRoleKind('cnc_grinding'), 'cnc_operator');
    expect(agencyTradeKeyForRoleKind('cam_programmer'), 'cnc_programmer');
    expect(agencyTradeKeyForRoleKind('cad_draughtsman'), 'autocad_draftsman');
    expect(agencyTradeKeyForRoleKind('conventional_machinist'),
        'machine_operator');
    expect(agencyTradeKeyForRoleKind('tool_die_maker'), 'tool_room_technician');
    expect(agencyTradeKeyForRoleKind('welder'), 'machine_operator');
    expect(agencyTradeKeyForRoleKind('sheet_metal_worker'), 'machine_operator');
    expect(agencyTradeKeyForRoleKind('press_operator'), 'machine_operator');
    expect(agencyTradeKeyForRoleKind('painter_coating'), 'machine_operator');
    expect(agencyTradeKeyForRoleKind('fitter'), 'fitter');
    expect(agencyTradeKeyForRoleKind('maintenance_technician'),
        'maintenance_technician');
    expect(agencyTradeKeyForRoleKind('industrial_electrician'),
        'maintenance_technician');
    expect(agencyTradeKeyForRoleKind('assembly_line_worker'),
        'assembly_technician');
    expect(agencyTradeKeyForRoleKind('quality_inspector'),
        'quality_inspector');
  });

  test('no role or an unknown role derives nothing', () {
    expect(agencyTradeKeyForRoleKind(null), isNull);
    expect(agencyTradeKeyForRoleKind('not_a_role'), isNull);
  });
}

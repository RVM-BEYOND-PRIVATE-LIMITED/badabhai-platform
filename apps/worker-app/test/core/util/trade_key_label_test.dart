import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/trade_key_label.dart';

/// The standing rule this exists for: a worker never reads a slug, an id or an
/// enum. `GET /workers/me/applications` sends `trade_key` and no label for it
/// (#1051), so the Applied row put "cnc_operator · Pune" on screen.
void main() {
  group('tradeKeyLabel — the taxonomy names', () {
    test('maps the alpha trades to their canonical taxonomy name', () {
      expect(tradeKeyLabel('cnc_operator'), 'CNC Operator');
      expect(tradeKeyLabel('cnc_turner_operator'), 'CNC Turner/Operator');
      expect(tradeKeyLabel('cnc_setter_operator'), 'CNC Setter-Operator');
      expect(tradeKeyLabel('vmc_operator'), 'VMC Operator');
      expect(tradeKeyLabel('hmc_operator'), 'HMC Operator');
      expect(tradeKeyLabel('cam_programmer'), 'CAM Programmer');
      expect(tradeKeyLabel('welder'), 'Welder');
      expect(tradeKeyLabel('interior_designer'), 'Interior Designer');
    });

    test('is case-insensitive about the key', () {
      expect(tradeKeyLabel('CNC_Operator'), 'CNC Operator');
    });
  });

  group('tradeKeyLabel — the fallback', () {
    test('title-cases an unknown slug and keeps the acronyms in caps', () {
      expect(tradeKeyLabel('vmc_setter'), 'VMC Setter');
      expect(tradeKeyLabel('quality_inspector'), 'Quality Inspector');
      expect(tradeKeyLabel('fitter'), 'Fitter');
      expect(tradeKeyLabel('iti_trainee'), 'ITI Trainee');
      expect(tradeKeyLabel('qc_inspector'), 'QC Inspector');
    });

    test('NEVER returns the raw key', () {
      for (final String key in <String>[
        'cnc_operator',
        'vmc_setter',
        'quality_inspector',
        'some_new_trade_nobody_mapped',
      ]) {
        expect(tradeKeyLabel(key), isNot(key));
        expect(tradeKeyLabel(key), isNot(contains('_')));
      }
    });

    test('leaves a word the worker already capitalised alone', () {
      expect(tradeKeyLabel('ITI fitter'), 'ITI Fitter');
    });
  });

  group('tradeKeyLabel — nothing honest to show', () {
    test('an internal id returns empty so the caller hides the line', () {
      // #1027 — under MATCH_V1 `trade_key` IS an mskill_ id.
      expect(tradeKeyLabel('mskill_mig_welder'), '');
      expect(tradeKeyLabel('role_welder'), '');
      expect(tradeKeyLabel('skill_turning'), '');
      expect(tradeKeyLabel('mach_vmc'), '');
      expect(tradeKeyLabel('dom_welding'), '');
      expect(tradeKeyLabel('ind_industrial_manufacturing'), '');
      expect(tradeKeyLabel('ctrl_fanuc'), '');
      expect(tradeKeyLabel('trade_cnc'), '');
    });

    test('an empty or blank key returns empty', () {
      expect(tradeKeyLabel(''), '');
      expect(tradeKeyLabel('   '), '');
    });
  });
}

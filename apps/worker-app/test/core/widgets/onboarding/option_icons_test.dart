import 'package:badabhai_worker_app/core/widgets/onboarding/form_glyphs.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/option_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// The form-flow mockups (14 Turning Operations, 15 Workholding, 16 Measuring
/// Instruments) draw their own glyph for each of their options. These are the
/// REAL options of those three questions (`qp_cnc_turning.json`), keyed exactly
/// as the server sends them.
void main() {
  group('iconForOption — the mockup options draw the traced glyphs', () {
    const List<(String, String, String, IconData)> cases =
        <(String, String, String, IconData)>[
      ('workholding', 'three_jaw', 'Teen jaw chuck', FormGlyphs.teenJawChuck),
      ('workholding', 'four_jaw', 'Chaar jaw chuck', FormGlyphs.chaarJawChuck),
      ('workholding', 'collet', 'Collet', FormGlyphs.collet),
      ('workholding', 'soft_jaw', 'Soft jaw', FormGlyphs.softJaw),
      ('workholding', 'tailstock', 'Tailstock ya centre',
          FormGlyphs.tailstockCentre),
      ('workholding', 'steady_rest', 'Steady rest', FormGlyphs.steadyRest),
      ('measuring_tools', 'vernier', 'Vernier caliper',
          FormGlyphs.vernierCaliper),
      ('measuring_tools', 'micrometer', 'Micrometer', FormGlyphs.micrometer),
      ('measuring_tools', 'bore_gauge', 'Bore dial gauge',
          FormGlyphs.boreDialGauge),
      ('measuring_tools', 'height_gauge', 'Height gauge',
          FormGlyphs.heightGauge),
      ('measuring_tools', 'plug_gauge', 'Plug ya ring gauge',
          FormGlyphs.plugRingGauge),
      ('measuring_tools', 'dial_indicator', 'Dial indicator',
          FormGlyphs.dialIndicator),
      ('turning_operation', 'facing_od', 'Facing aur OD turning',
          FormGlyphs.facingOdTurning),
      ('turning_operation', 'boring', 'Boring, ID turning',
          FormGlyphs.boringIdTurning),
      ('turning_operation', 'threading', 'Threading', FormGlyphs.threading),
      ('turning_operation', 'grooving', 'Grooving aur parting',
          FormGlyphs.groovingParting),
      ('turning_operation', 'drilling', 'Drilling aur tapping',
          FormGlyphs.drillingTapping),
      ('turning_operation', 'knurling', 'Knurling aur taper',
          FormGlyphs.knurlingTaper),
    ];

    for (final (String question, String key, String label, IconData glyph)
        in cases) {
      test('$question / $key -> ${glyph.codePoint.toRadixString(16)}', () {
        expect(
          iconForOption(optionKey: key, label: label, questionKey: question),
          glyph,
        );
      });
    }

    test('the 18 glyphs are distinct', () {
      expect(cases.map((c) => c.$4).toSet(), hasLength(cases.length));
    });
  });

  group('iconForOption — everything else keeps its Material icon', () {
    test('a fallback choice still reads as a fallback, not a tool', () {
      expect(
        iconForOption(
          optionKey: 'none_of_these',
          label: 'Inme se koi nahi',
          questionKey: 'workholding',
        ),
        Icons.more_horiz_rounded,
      );
    });

    test('an option outside the mockups is unchanged', () {
      expect(
        iconForOption(optionKey: 'magnetic', label: 'Magnetic chuck'),
        Icons.hub_outlined,
      );
      expect(
        iconForOption(optionKey: 'slip_gauge', label: 'Slip gauge'),
        Icons.view_week_outlined,
      );
    });

    test('an unrecognised option falls back to its question icon', () {
      expect(
        iconForOption(
          optionKey: 'qqq',
          label: 'Qqq',
          questionKey: 'workholding',
        ),
        Icons.gps_fixed_rounded,
      );
    });
  });
}

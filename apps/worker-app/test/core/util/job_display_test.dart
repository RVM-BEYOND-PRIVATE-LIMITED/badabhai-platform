import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/job_display.dart';

/// Display mappers for the coarse job enums (ADR-0024 addendum, 2026-07-16).
/// The hide-on-unknown rule matters most: an unrecognised wire value returns
/// null so the row HIDES — never echoed, never guessed.
void main() {
  group('shiftLabel', () {
    test('maps the three known shifts', () {
      expect(shiftLabel('day'), 'Day');
      expect(shiftLabel('night'), 'Night');
      expect(shiftLabel('rotational'), 'Rotational');
    });

    test('unknown or absent → null (row hides)', () {
      expect(shiftLabel(null), isNull);
      expect(shiftLabel('graveyard'), isNull);
      expect(shiftLabel(''), isNull);
    });
  });

  group('neededByLabel', () {
    test('maps the three known urgencies to Hinglish copy', () {
      expect(neededByLabel('immediate'), 'Turant chahiye');
      expect(neededByLabel('soon'), 'Jaldi chahiye');
      expect(neededByLabel('flexible'), 'Flexible');
    });

    test('unknown or absent → null (row hides)', () {
      expect(neededByLabel(null), isNull);
      expect(neededByLabel('yesterday'), isNull);
    });
  });

  group('experienceLabel', () {
    test('both bounds → the filters-sheet window vocabulary', () {
      expect(experienceLabel(2, 5), '2–5 yrs experience');
      expect(experienceLabel(0, 2), '0–2 yrs experience');
    });

    test('equal bounds → single count', () {
      expect(experienceLabel(3, 3), '3 yrs experience');
    });

    test('one-sided windows stay honest', () {
      expect(experienceLabel(5, null), '5+ yrs experience');
      expect(experienceLabel(null, 5), 'Up to 5 yrs experience');
    });

    test('no window at all → null — never invents a floor or ceiling', () {
      expect(experienceLabel(null, null), isNull);
    });
  });
}

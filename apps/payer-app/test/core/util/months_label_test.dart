import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/util/months_label.dart';

/// The app's one months→years formatter — the same table payer-web's
/// `monthsLabel` prints, so both surfaces show a worker the same years. It
/// rounds DOWN, and never prints more precision than the 6-month bucket holds.
void main() {
  test('matches payer-web monthsLabel case for case', () {
    const Map<int?, String> cases = <int?, String>{
      null: '',
      0: '',
      -6: '',
      6: '6 mo',
      12: '1 yr',
      18: '1.5 yrs',
      24: '2 yrs',
      47: '3.5 yrs',
      48: '4 yrs',
      54: '4.5 yrs',
      120: '10 yrs',
    };
    cases.forEach((int? months, String label) {
      expect(monthsLabel(months), label, reason: 'monthsLabel($months)');
    });
  });
}

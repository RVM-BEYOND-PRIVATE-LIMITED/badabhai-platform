import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/companion_edit_value.dart';

/// ADR-0046 §5.1 — the edit card must never ask a worker to confirm a change
/// written in ids.
///
/// The server fills `before`/`after` straight from the edit catalogue, and for
/// nine of its fields that value is a closed-set TOKEN. Each case below is a
/// real catalogue field, not an invented one.
void main() {
  group('tokens the catalogue really sends', () {
    test('occupations:role_id — a taxonomy id becomes its trade name', () {
      expect(companionEditValue('role_cnc_operator'), 'CNC Operator');
      expect(companionEditValue('role_welder'), 'Welder');
    });

    test('preferences:shift / job_type — slugs become their labels', () {
      expect(companionEditValue('night'), 'Night shift');
      expect(companionEditValue('rotational'), 'Rotational shifts');
      expect(companionEditValue('daily_wage'), 'Daily wage');
      expect(companionEditValue('apprentice'), 'Apprenticeship');
    });

    test('the three boolean preferences read as Haan / Nahi', () {
      // willing_to_travel, willing_to_relocate, accommodation_needed all arrive
      // as the literal strings "true"/"false".
      expect(companionEditValue('true'), 'Haan');
      expect(companionEditValue('false'), 'Nahi');
      expect(companionEditValue('TRUE'), 'Haan');
    });

    test('a slug this build does not know is still never shown raw', () {
      // languages:language, qualifications:education_credential and
      // availability_status are closed sets the card can carry whose members
      // this build has no table for.
      expect(companionEditValue('hindi'), 'Hindi');
      expect(companionEditValue('serving_notice'), 'Serving Notice');
      expect(companionEditValue('within_week'), 'Within Week');
      // Nothing that came back may still look like a token.
      for (final String out in <String>[
        companionEditValue('hindi'),
        companionEditValue('serving_notice'),
        companionEditValue('some_future_slug'),
      ]) {
        expect(out.contains('_'), isFalse, reason: 'raw token leaked: $out');
      }
    });
  });

  group("the worker's own words survive untouched", () {
    test('free text keeps its spelling, spacing and capitals', () {
      // employer_name, work_done, certificate_name, employer_city — a worker's
      // own typing, where re-casing would be a second bug.
      const List<String> free = <String>[
        'Bharat Forge Ltd',
        'RVM CAD Pvt Ltd',
        'CNC machine par turning aur milling',
        'Pune',
        'ITI Fitter',
        'B.Tech',
      ];
      for (final String value in free) {
        expect(companionEditValue(value), value, reason: value);
      }
    });

    test('dates, years and amounts are left exactly as they are', () {
      // start_ym / end_ym are `YYYY-MM`; the year and salary fields are digits.
      expect(companionEditValue('2024-03'), '2024-03');
      expect(companionEditValue('2019'), '2019');
      expect(companionEditValue('25000'), '25000');
    });

    test('empty and whitespace stay empty — never "Null" or a stray label', () {
      expect(companionEditValue(''), '');
      expect(companionEditValue('   '), '');
    });
  });
}

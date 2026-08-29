// #1322 — the `missing_fields` slug humanizer. A low-literacy worker must never
// see a raw slug (`role`, `salary`, …) on screen; every one of the nine closed
// keys maps to a readable Hinglish phrase, and any future/unknown token is
// prettified rather than leaked verbatim.
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/missing_field_label.dart';

void main() {
  group('humanizeMissingField', () {
    const List<String> knownSlugs = <String>[
      'role',
      'trade',
      'skills',
      'machines',
      'experience',
      'salary',
      'location',
      'availability',
      'photo',
    ];

    test('every one of the nine canonical slugs maps to a readable label', () {
      const Map<String, String> expected = <String, String>{
        'role': 'apna kaam / role',
        'trade': 'apni industry',
        'skills': 'apni skills',
        'machines': 'apni machines',
        'experience': 'apna kaam-anubhav',
        'salary': 'salary ki ummeed',
        'location': 'kaam ki jagah',
        'availability': 'kaam ki availability',
        'photo': 'apni photo',
      };
      expected.forEach((String slug, String label) {
        expect(humanizeMissingField(slug), label);
      });
    });

    test('no known slug is ever returned as the bare identifier', () {
      for (final String slug in knownSlugs) {
        expect(humanizeMissingField(slug), isNot(equals(slug)));
      }
    });

    test('case-insensitive on the known set', () {
      expect(humanizeMissingField('SALARY'), 'salary ki ummeed');
      expect(humanizeMissingField(' Photo '), 'apni photo');
    });

    test('an unknown snake_case token is prettified, never leaked raw', () {
      expect(humanizeMissingField('work_permit'), 'Work Permit');
      expect(humanizeMissingField('driving_licence'), 'Driving Licence');
    });

    test('empty stays empty (nothing to render)', () {
      expect(humanizeMissingField(''), '');
      expect(humanizeMissingField('   '), '');
    });
  });
}

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/education_label.dart';

/// `education_level` is a free-text scalar; the model sometimes emits a token
/// like `below_10` instead of a readable label (the profile bug). The humanizer
/// must never let a raw token reach the worker, while leaving already-readable
/// labels untouched (acronyms/casing preserved).
void main() {
  group('humanizeEducationLevel', () {
    test('the known token becomes a readable label', () {
      expect(humanizeEducationLevel('below_10'), '10th se kam');
      expect(humanizeEducationLevel('below_10th'), '10th se kam');
    });

    test('mapping is case-insensitive and trims surrounding space', () {
      expect(humanizeEducationLevel('  BELOW_10 '), '10th se kam');
    });

    test('already-readable labels are returned unchanged (casing preserved)',
        () {
      for (final String label in <String>['12th', '10th', 'ITI', 'Diploma',
          'B.Tech', 'Graduate']) {
        expect(humanizeEducationLevel(label), label);
      }
    });

    test('any other snake_case token is prettified, not shown raw', () {
      expect(humanizeEducationLevel('post_graduate'), 'Post Graduate');
      expect(humanizeEducationLevel('no_formal_education'),
          'No Formal Education');
    });

    test('empty stays empty', () {
      expect(humanizeEducationLevel(''), '');
      expect(humanizeEducationLevel('   '), '');
    });
  });
}

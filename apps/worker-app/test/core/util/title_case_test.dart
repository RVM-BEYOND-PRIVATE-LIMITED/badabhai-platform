import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/title_case.dart';

void main() {
  group('titleCaseName', () {
    test('capitalizes the first letter of each lowercase word', () {
      expect(titleCaseName('rvm cad pvt lt'), 'Rvm Cad Pvt Lt');
    });

    test('single word', () {
      expect(titleCaseName('faridabad'), 'Faridabad');
    });

    test('already-capitalized text is unchanged', () {
      expect(titleCaseName('Asha Kumari'), 'Asha Kumari');
    });

    test('never touches a letter that is already uppercase — a deliberate '
        'abbreviation typed in caps survives untouched', () {
      expect(titleCaseName('RVM CAD'), 'RVM CAD');
      expect(titleCaseName('ITI Faridabad'), 'ITI Faridabad');
      expect(titleCaseName('NIFT'), 'NIFT');
    });

    test('mixed case: only a lowercase FIRST letter is fixed, nothing else '
        'in the word is touched', () {
      expect(titleCaseName('mCA institute'), 'MCA Institute');
    });

    test('empty string', () {
      expect(titleCaseName(''), '');
    });

    test('leading/trailing/multiple internal spaces are preserved', () {
      expect(titleCaseName('govt  iti'), 'Govt  Iti');
    });

    test('digits and punctuation as a word start are left alone (no letter '
        'to capitalize)', () {
      expect(titleCaseName('3d cad institute'), '3d Cad Institute');
    });
  });
}

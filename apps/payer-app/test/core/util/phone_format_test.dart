import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/util/phone_format.dart';

/// The account phone edit sends E.164; the backend `e164PhoneSchema`
/// (`/^\+[1-9]\d{7,14}$/`) rejects a bare national number. These pin that a payer
/// typing 10 digits (or pasting the number with common chrome) always produces a
/// number the server accepts — the fix for the "phone edit fails" report.
void main() {
  group('normalizeIndianMobileToE164', () {
    test('bare 10 national digits gain +91 (the reported case)', () {
      expect(normalizeIndianMobileToE164('8946991002'), '+918946991002');
    });

    test('tolerates spaces and dashes', () {
      expect(normalizeIndianMobileToE164('89469 91002'), '+918946991002');
      expect(normalizeIndianMobileToE164('8946-99-1002'), '+918946991002');
    });

    test('sheds a pasted 91 country prefix (12 digits)', () {
      expect(normalizeIndianMobileToE164('918946991002'), '+918946991002');
    });

    test('sheds a pasted +91 country prefix', () {
      expect(normalizeIndianMobileToE164('+91 8946991002'), '+918946991002');
    });

    test('sheds a leading trunk 0 (11 digits)', () {
      expect(normalizeIndianMobileToE164('08946991002'), '+918946991002');
    });

    test('does NOT police the leading digit (server is the authority)', () {
      // A 10-digit number starting with 1 still normalises — the client never
      // guesses operator series (mirrors the worker app).
      expect(normalizeIndianMobileToE164('1234567890'), '+911234567890');
    });

    test('rejects too-few / too-many digits', () {
      expect(normalizeIndianMobileToE164('894699100'), isNull); // 9
      expect(normalizeIndianMobileToE164('89469910022'), isNull); // 11, no 0/91
      expect(normalizeIndianMobileToE164(''), isNull);
      expect(normalizeIndianMobileToE164('abc'), isNull);
    });

    test('the composed number satisfies the backend E.164 rule', () {
      final String? e164 = normalizeIndianMobileToE164('8946991002');
      expect(e164, isNotNull);
      expect(RegExp(r'^\+[1-9]\d{7,14}$').hasMatch(e164!), isTrue);
    });
  });

  test('isValidIndianMobile mirrors the normaliser', () {
    expect(isValidIndianMobile('8946991002'), isTrue);
    expect(isValidIndianMobile('123'), isFalse);
  });
}

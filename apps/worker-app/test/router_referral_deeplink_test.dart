import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/router.dart';

void main() {
  group('referralCodeFromUri — both deep-link shapes', () {
    test('custom scheme badabhai://i/<code> (host carries the "i")', () {
      expect(
        referralCodeFromUri(Uri.parse('badabhai://i/abcdef012345')),
        'abcdef012345',
      );
    });

    test('App-Link / path form https://<domain>/i/<code>', () {
      expect(
        referralCodeFromUri(Uri.parse('https://app.badabhai.in/i/abcdef012345')),
        'abcdef012345',
      );
    });

    test('bare in-app path /i/<code>', () {
      expect(referralCodeFromUri(Uri.parse('/i/abcdef012345')), 'abcdef012345');
    });

    test('non-referral routes return null (no collision with app routes)', () {
      expect(referralCodeFromUri(Uri.parse('/')), isNull);
      expect(referralCodeFromUri(Uri.parse('/invite')), isNull);
      expect(referralCodeFromUri(Uri.parse('/jobs')), isNull);
      expect(referralCodeFromUri(Uri.parse('/consent')), isNull);
      // "/i" with no code is not a referral link.
      expect(referralCodeFromUri(Uri.parse('/i')), isNull);
      expect(referralCodeFromUri(Uri.parse('badabhai://i')), isNull);
    });

    test('extraction does not shape-validate (the store does)', () {
      // A malformed code is still EXTRACTED here; PendingReferralStore.capture
      // is the single validator that drops it. This keeps the two shapes and the
      // shape check in exactly one place each.
      expect(referralCodeFromUri(Uri.parse('/i/NOT-A-CODE')), 'NOT-A-CODE');
    });
  });
}

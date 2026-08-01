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

    // B4 — the https filter is now DECLARED in AndroidManifest.xml with
    // `android:autoVerify="true"`, so these shapes stop opening a browser and
    // start reaching this function. `kInviteLinkBase` composes exactly this
    // host, which is why every shared link used to be lost.
    group('App-Link shapes a real share/browser actually produces', () {
      test('with tracking query params appended', () {
        expect(
          referralCodeFromUri(Uri.parse(
              'https://app.badabhai.in/i/abcdef012345?utm_source=whatsapp')),
          'abcdef012345',
        );
      });

      test('with a trailing slash', () {
        expect(
          referralCodeFromUri(
              Uri.parse('https://app.badabhai.in/i/abcdef012345/')),
          'abcdef012345',
        );
      });

      test('with a fragment', () {
        expect(
          referralCodeFromUri(
              Uri.parse('https://app.badabhai.in/i/abcdef012345#ref')),
          'abcdef012345',
        );
      });

      test('host case is normalised by Uri, so a shouty link still works', () {
        expect(
          referralCodeFromUri(
              Uri.parse('https://APP.BadaBhai.in/i/abcdef012345')),
          'abcdef012345',
        );
      });

      test('http (not https) still parses — the manifest scopes the scheme', () {
        // Extraction is scheme-agnostic on purpose: the intent-filter decides
        // which schemes reach the app, and this stays a pure parser.
        expect(
          referralCodeFromUri(Uri.parse('http://app.badabhai.in/i/abcdef012345')),
          'abcdef012345',
        );
      });

      test('custom scheme with query params (the legacy fallback)', () {
        expect(
          referralCodeFromUri(
              Uri.parse('badabhai://i/abcdef012345?utm_source=sms')),
          'abcdef012345',
        );
      });
    });

    test('junk and near-misses return null rather than a fake code', () {
      // `/i/` with nothing after it.
      expect(referralCodeFromUri(Uri.parse('https://app.badabhai.in/i/')), isNull);
      expect(referralCodeFromUri(Uri.parse('https://app.badabhai.in/i')), isNull);
      // A DIFFERENT first segment is not our shape, even under our host.
      expect(
        referralCodeFromUri(Uri.parse('https://app.badabhai.in/invite/abcdef012345')),
        isNull,
      );
      // The bare marketing site.
      expect(referralCodeFromUri(Uri.parse('https://app.badabhai.in/')), isNull);
      expect(referralCodeFromUri(Uri.parse('https://app.badabhai.in')), isNull);
      // Not a URI shape at all.
      expect(referralCodeFromUri(Uri.parse('nonsense')), isNull);
      expect(referralCodeFromUri(Uri.parse('')), isNull);
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

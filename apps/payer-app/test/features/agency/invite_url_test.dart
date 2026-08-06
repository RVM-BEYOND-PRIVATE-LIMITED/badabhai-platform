import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/features/agency/util/invite_url.dart';

/// `absoluteInviteUrl` had ZERO coverage while being the difference between a
/// scannable QR / pasteable link and a bare path that resolves to nothing. It is
/// also the function `ReferralScreen` was not calling, which is the bug this
/// workstream fixes — so every branch is pinned here, not just the happy one.
void main() {
  const String origin = 'https://app.badabhai.in';

  group('absoluteInviteUrl', () {
    test('passes an already-absolute url through untouched', () {
      expect(
        absoluteInviteUrl('https://app.badabhai.in/i/abc123', webOrigin: origin),
        'https://app.badabhai.in/i/abc123',
      );
      // A non-https absolute url is still absolute — this function resolves
      // shapes, it does not enforce transport (resolvePayerWebUrl does that).
      expect(
        absoluteInviteUrl('http://localhost:3000/i/abc123', webOrigin: origin),
        'http://localhost:3000/i/abc123',
      );
    });

    test('resolves the PATH-ONLY wire shape against the payer-web origin', () {
      // This is what `POST /payer/agency/invites` actually returns.
      expect(
        absoluteInviteUrl('/i/abc123', webOrigin: origin),
        'https://app.badabhai.in/i/abc123',
      );
    });

    test('gives a scheme-less host https', () {
      expect(
        absoluteInviteUrl('badabhai.in/i/abc123', webOrigin: origin),
        'https://badabhai.in/i/abc123',
      );
    });

    test('inherits https for a protocol-relative url', () {
      expect(
        absoluteInviteUrl('//badabhai.in/i/abc123', webOrigin: origin),
        'https://badabhai.in/i/abc123',
      );
    });

    test('drops any query/fragment on the ORIGIN when resolving a path', () {
      expect(
        absoluteInviteUrl('/i/abc123', webOrigin: 'https://app.badabhai.in/x?a=1#f'),
        'https://app.badabhai.in/i/abc123',
      );
    });

    test('returns a path-only link unchanged when there is no origin at all', () {
      // Degrades rather than crashing. A QR of this is useless, but the card
      // still renders — and in production the origin has a baked-in default.
      expect(absoluteInviteUrl('/i/abc123', webOrigin: null), '/i/abc123');
    });

    test('is empty-safe and trims', () {
      expect(absoluteInviteUrl('', webOrigin: origin), '');
      expect(absoluteInviteUrl('   ', webOrigin: origin), '');
      expect(
        absoluteInviteUrl('  /i/abc123  ', webOrigin: origin),
        'https://app.badabhai.in/i/abc123',
      );
    });
  });
}

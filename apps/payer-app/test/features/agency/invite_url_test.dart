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
        absoluteInviteUrl('https://app.badabhai.in/i/abc123',
            configuredWebUrl: origin),
        'https://app.badabhai.in/i/abc123',
      );
      // A non-https absolute url is still absolute — this function resolves
      // shapes, it does not enforce transport (resolvePayerWebUrl does that).
      expect(
        absoluteInviteUrl('http://localhost:3000/i/abc123',
            configuredWebUrl: origin),
        'http://localhost:3000/i/abc123',
      );
    });

    test('resolves the PATH-ONLY wire shape against the payer-web origin', () {
      // This is what `POST /payer/agency/invites` actually returns.
      expect(
        absoluteInviteUrl('/i/abc123', configuredWebUrl: origin),
        'https://app.badabhai.in/i/abc123',
      );
    });

    test('gives a scheme-less host https', () {
      expect(
        absoluteInviteUrl('badabhai.in/i/abc123', configuredWebUrl: origin),
        'https://badabhai.in/i/abc123',
      );
    });

    test('inherits https for a protocol-relative url', () {
      expect(
        absoluteInviteUrl('//badabhai.in/i/abc123', configuredWebUrl: origin),
        'https://badabhai.in/i/abc123',
      );
    });

    test('drops the ORIGIN path and query when resolving a path', () {
      // REGRESSION PIN. The implementation asked for `query: null,
      // fragment: null`, which in Dart means "keep them" — so a PAYER_WEB_URL
      // carrying a query leaked it into every invite link, QR and WhatsApp
      // message: this case returned `…/i/abc123?a=1`. RED before the fix.
      expect(
        absoluteInviteUrl('/i/abc123',
            configuredWebUrl: 'https://app.badabhai.in/x?a=1'),
        'https://app.badabhai.in/i/abc123',
      );
      // An explicit port is part of the authority and must survive; a default
      // one must not be invented.
      expect(
        absoluteInviteUrl('/i/abc123', configuredWebUrl: 'https://x.test:8443/deep/path'),
        'https://x.test:8443/i/abc123',
      );
    });

    test('an origin with a FRAGMENT is rejected upstream, not resolved', () {
      // Dart quirk worth pinning: `Uri.isAbsolute` is false when a fragment is
      // present, so resolvePayerWebUrl rejects such a PAYER_WEB_URL and this
      // degrades instead of silently resolving against it.
      expect(
        absoluteInviteUrl('/i/abc123',
            configuredWebUrl: 'https://app.badabhai.in/x#f'),
        '/i/abc123',
      );
    });

    test('never lets origin credentials ride along to a candidate', () {
      // A share URL ends up on a printed poster and in a stranger's WhatsApp.
      // RFC 3986 resolution carries userInfo across; this must not.
      expect(
        absoluteInviteUrl('/i/abc123',
            configuredWebUrl: 'https://user:secret@app.badabhai.in'),
        'https://app.badabhai.in/i/abc123',
      );
    });

    test('a query the LINK itself carries is preserved', () {
      expect(
        absoluteInviteUrl('/i/abc123?utm=poster', configuredWebUrl: origin),
        'https://app.badabhai.in/i/abc123?utm=poster',
      );
    });

    test('with nothing injected it falls back to the configured origin', () {
      // Production call shape: every caller passes only the link. In a test
      // build PAYER_WEB_URL is unset, so this is the baked-in default.
      expect(
        absoluteInviteUrl('/i/abc123'),
        'https://app.badabhai.in/i/abc123',
      );
    });

    test('degrades to the raw path when the origin is UNUSABLE', () {
      // Reachable in production via a bad `--dart-define=PAYER_WEB_URL`:
      // resolvePayerWebUrl rejects plaintext and malformed values, returning
      // null. Degrades rather than crashing — the card still renders.
      expect(
        absoluteInviteUrl('/i/abc123', configuredWebUrl: 'http://insecure.test'),
        '/i/abc123',
      );
      expect(
        absoluteInviteUrl('/i/abc123', configuredWebUrl: 'not a url'),
        '/i/abc123',
      );
    });

    test('is empty-safe and trims', () {
      expect(absoluteInviteUrl('', configuredWebUrl: origin), '');
      expect(absoluteInviteUrl('   ', configuredWebUrl: origin), '');
      expect(
        absoluteInviteUrl('  /i/abc123  ', configuredWebUrl: origin),
        'https://app.badabhai.in/i/abc123',
      );
    });
  });
}

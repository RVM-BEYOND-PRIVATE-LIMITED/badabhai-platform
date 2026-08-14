import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/config/app_config.dart';

/// With no `API_BASE_URL` override, the app falls back to the shared default
/// backend — a live `https` origin (never localhost) — so a plain build reaches
/// a real API in both debug and release. An explicit override still wins, and in
/// release it must be a well-formed https origin or the resolver fails LOUDLY at
/// startup (a plaintext/malformed value would fail every request or put the
/// bearer token on the wire in the clear).
const String _kDefault = 'https://43-204-36-199.sslip.io';

void main() {
  group('resolvePayerApiBaseUrl — default backend (no override)', () {
    test('empty in release falls back to the https default, never localhost',
        () {
      final String url =
          resolvePayerApiBaseUrl(configuredUrl: '', isRelease: true);
      expect(url, _kDefault);
      expect(Uri.parse(url).scheme, 'https');
      // Whitespace-only is still "no override" → the default.
      expect(
        resolvePayerApiBaseUrl(configuredUrl: '   ', isRelease: true),
        _kDefault,
      );
    });

    test('empty in debug also uses the default so no flag / adb reverse needed',
        () {
      expect(
        resolvePayerApiBaseUrl(configuredUrl: '', isRelease: false),
        _kDefault,
      );
    });
  });

  group('resolvePayerApiBaseUrl — explicit override in release', () {
    test('non-https → StateError (a bearer must never ride plaintext)', () {
      for (final String url in <String>[
        'http://api.badabhai.in',
        'http://10.0.2.2:3001',
      ]) {
        expect(
          () => resolvePayerApiBaseUrl(configuredUrl: url, isRelease: true),
          throwsA(isA<StateError>()),
          reason: '$url must be rejected in release',
        );
      }
    });

    test('malformed / hostless → StateError', () {
      for (final String url in <String>['not a url', 'https://', '/payer']) {
        expect(
          () => resolvePayerApiBaseUrl(configuredUrl: url, isRelease: true),
          throwsA(isA<StateError>()),
          reason: '$url must be rejected in release',
        );
      }
    });

    test('a well-formed https origin is accepted (and trimmed)', () {
      expect(
        resolvePayerApiBaseUrl(
          configuredUrl: 'https://api.badabhai.in',
          isRelease: true,
        ),
        'https://api.badabhai.in',
      );
      expect(
        resolvePayerApiBaseUrl(
          configuredUrl: '  https://api.badabhai.in  ',
          isRelease: true,
        ),
        'https://api.badabhai.in',
      );
    });
  });

  group('resolvePayerApiBaseUrl — debug rules', () {
    test('a supplied URL wins, and plaintext is allowed in debug only', () {
      expect(
        resolvePayerApiBaseUrl(
          configuredUrl: 'http://192.168.1.5:3001',
          isRelease: false,
        ),
        'http://192.168.1.5:3001',
      );
    });
  });

  /// The web origin the "Manage plan on web" link opens. It exists because
  /// every money action was REMOVED from this app (store IAP policy), which
  /// would otherwise leave the payer at a dead end.
  group('resolvePayerWebUrl — the external money surface', () {
    test('defaults to the documented payer-web origin, over https', () {
      final String? url = resolvePayerWebUrl(configuredUrl: '');
      expect(url, isNotNull);
      expect(Uri.parse(url!).scheme, 'https');
    });

    test('a supplied https origin wins', () {
      expect(
        resolvePayerWebUrl(configuredUrl: '  https://portal.example.com  '),
        'https://portal.example.com',
      );
    });

    test('plaintext / malformed → null, so the UI shows the honest copy with '
        'NO broken link rather than launching a dead URL', () {
      for (final String bad in <String>[
        'http://portal.example.com',
        'portal.example.com',
        'not a url',
        '://nope',
      ]) {
        expect(resolvePayerWebUrl(configuredUrl: bad), isNull, reason: bad);
      }
    });
  });
}

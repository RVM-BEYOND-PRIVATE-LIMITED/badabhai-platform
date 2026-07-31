import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/config/app_config.dart';

/// The release base URL is a SHIP BLOCKER: the app used to default to the
/// Android emulator alias `10.0.2.2`, which is unreachable from a real device,
/// so a release build would have silently failed every request. A release must
/// now be built with `--dart-define=API_BASE_URL=https://…` or die at startup.
void main() {
  group('resolvePayerApiBaseUrl — release rules', () {
    test('missing API_BASE_URL → StateError (never the emulator alias)', () {
      expect(
        () => resolvePayerApiBaseUrl(configuredUrl: '', isRelease: true),
        throwsA(isA<StateError>()),
      );
      // Whitespace-only is still "missing".
      expect(
        () => resolvePayerApiBaseUrl(configuredUrl: '   ', isRelease: true),
        throwsA(isA<StateError>()),
      );
    });

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
    test('empty falls back to the loopback (works on emulator + USB device)',
        () {
      // Matches the worker app: localhost + `adb reverse tcp:3001` reaches the
      // host API from a real device over USB (10.0.2.2 was emulator-only).
      expect(
        resolvePayerApiBaseUrl(configuredUrl: '', isRelease: false),
        'http://localhost:3001',
      );
    });

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

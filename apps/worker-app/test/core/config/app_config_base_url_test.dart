import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/config/app_config.dart';

/// With no `API_BASE_URL` override, the app falls back to the shared default
/// backend — a live `https` origin (never localhost) — so a plain build reaches
/// a real API in both debug and release. An explicit override still wins, and in
/// release it must be a well-formed https origin or the resolver fails LOUDLY at
/// startup (a plaintext/malformed value would fail every request or put the
/// session token on the wire in the clear).
///
/// `isRelease` is injected because a unit test always runs in debug and
/// `API_BASE_URL` is fixed at compile time.
const String _kDefault = 'https://43-204-36-199.sslip.io';

void main() {
  group('default backend (no override)', () {
    test('empty in release falls back to the https default, never localhost', () {
      final String url = resolveApiBaseUrl(configuredUrl: '', isRelease: true);
      expect(url, _kDefault);
      expect(Uri.parse(url).scheme, 'https');
    });

    test('empty in debug also uses the default so no flag is needed', () {
      expect(resolveApiBaseUrl(configuredUrl: '', isRelease: false), _kDefault);
    });
  });

  group('explicit override', () {
    test('plaintext http is rejected in release (token would ride in clear)',
        () {
      expect(
        () => resolveApiBaseUrl(
            configuredUrl: 'http://api.example.com', isRelease: true),
        throwsA(isA<StateError>()
            .having((StateError e) => e.message, 'message', contains('https'))),
      );
    });

    test('malformed url is rejected in release', () {
      expect(
        () => resolveApiBaseUrl(configuredUrl: 'not-a-url', isRelease: true),
        throwsA(isA<StateError>()),
      );
    });

    test('an https override is accepted and trimmed in release', () {
      expect(
        resolveApiBaseUrl(
            configuredUrl: '  https://api.example.com  ', isRelease: true),
        'https://api.example.com',
      );
    });

    test('an explicit value still wins in debug (incl. a LAN http dev API)', () {
      expect(
        resolveApiBaseUrl(
            configuredUrl: 'http://10.0.2.2:3001', isRelease: false),
        'http://10.0.2.2:3001',
      );
    });
  });
}

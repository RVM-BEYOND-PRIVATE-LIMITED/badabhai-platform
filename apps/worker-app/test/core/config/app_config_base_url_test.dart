import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/config/app_config.dart';

/// The release build MUST be handed an https API_BASE_URL. A shipped app that
/// silently falls back to `http://localhost:3001` reaches nothing on a real
/// worker's phone and fails every request — so the resolver fails LOUDLY at
/// startup instead.
///
/// `isRelease` is injected because a unit test always runs in debug and
/// `API_BASE_URL` is fixed at compile time.
void main() {
  group('release', () {
    test('missing API_BASE_URL throws instead of falling back to localhost', () {
      expect(
        () => resolveApiBaseUrl(configuredUrl: '', isRelease: true),
        throwsA(isA<StateError>().having(
            (StateError e) => e.message, 'message', contains('API_BASE_URL'))),
      );
    });

    test('plaintext http is rejected (token would ride in the clear)', () {
      expect(
        () => resolveApiBaseUrl(
            configuredUrl: 'http://api.example.com', isRelease: true),
        throwsA(isA<StateError>()
            .having((StateError e) => e.message, 'message', contains('https'))),
      );
    });

    test('malformed url is rejected', () {
      expect(
        () => resolveApiBaseUrl(configuredUrl: 'not-a-url', isRelease: true),
        throwsA(isA<StateError>()),
      );
    });

    test('https url is accepted and trimmed', () {
      expect(
        resolveApiBaseUrl(
            configuredUrl: '  https://api.example.com  ', isRelease: true),
        'https://api.example.com',
      );
    });
  });

  group('debug', () {
    test('empty falls back to the loopback so the local loop needs no flag', () {
      expect(resolveApiBaseUrl(configuredUrl: '', isRelease: false),
          'http://localhost:3001');
    });

    test('an explicit value still wins in debug', () {
      expect(
        resolveApiBaseUrl(
            configuredUrl: 'http://10.0.2.2:3001', isRelease: false),
        'http://10.0.2.2:3001',
      );
    });
  });
}

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/config/app_config.dart';

void main() {
  test('W1 — kPersistentAuth defaults ON (returning worker survives cold '
      'restart instead of re-doing OTP)', () {
    // `flutter test` passes no --dart-define, so this asserts the SHIPPED
    // default: kUseMocks(false) || PERSISTENT_AUTH(defaultValue true) == true.
    // The gate stays flag-driven in AuthSessionManager (bootstrap → locked when
    // a refresh token is persisted, else loggedOut — it never auto-unlocks).
    expect(kPersistentAuth, isTrue);
  });
}

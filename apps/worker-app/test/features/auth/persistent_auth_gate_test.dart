// Regression guard for the persistent-auth / PIN gate (PR #166 fix).
//
// The persistent-auth layer must be OFF by default in REAL builds: the backend
// `/auth/pin/*`, `/auth/token/refresh`, `/auth/devices` contract is not live, so
// running the PIN gate against the real backend dead-ends the worker after OTP.
// With the layer OFF the app falls back to main's proven OTP→shell flow.
//
// These tests construct the manager with `persistentAuthEnabled: false` (the real
// default) over the same fakes the other manager tests use, and assert the gate
// short-circuits every lock path — plus one positive contrast with the layer ON.
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';

import '../../core/auth/fakes.dart';
import 'auth_session_manager_test.dart' show ScriptAuthApi;

void main() {
  late FakeSecureStore secureBacking;
  late SecureTokenStore store;
  late SessionRepository session;
  late ReauthSignal reauth;
  late ScriptAuthApi api;

  AuthSessionManager build({required bool persistentAuthEnabled}) =>
      AuthSessionManager(
        authApi: api,
        tokenStore: store,
        session: session,
        reauthSignal: reauth,
        persistentAuthEnabled: persistentAuthEnabled,
      );

  setUp(() {
    secureBacking = FakeSecureStore();
    store = SecureTokenStore(secureBacking);
    session = SessionRepository();
    reauth = ReauthSignal();
    api = ScriptAuthApi(store);
  });

  tearDown(() {
    reauth.dispose();
  });

  group('persistent-auth layer OFF (real-build default)', () {
    test(
        'verifyOtp -> authenticated (NOT locked) even for a new user, and the '
        'access token is bridged into SessionRepository', () async {
      final AuthSessionManager manager =
          build(persistentAuthEnabled: false);
      // A brand-new user with no PIN — on main this still goes straight to the
      // shell after OTP; the gate must NOT route them to set-PIN.
      api
        ..isNewUser = true
        ..pinIsSet = false;

      await manager.verifyOtp('+91999', '1234');

      expect(manager.status, AuthStatus.authenticated);
      // The bridge still runs so worker-scoped calls keep their bearer.
      expect(session.sessionToken, 'access-otp');
      expect(session.workerId, 'worker-9');
      manager.dispose();
    });

    test('bootstrap -> loggedOut even WITH a remembered refresh token', () async {
      // Seed a refresh token: with the layer ON this would cold-start LOCKED.
      await store.writeRefreshToken('remembered');
      final AuthSessionManager manager =
          build(persistentAuthEnabled: false);

      final AuthStatus s = await manager.bootstrap();

      // The gate short-circuits BEFORE reading the store -> always phone login.
      expect(s, AuthStatus.loggedOut);
      expect(manager.status, AuthStatus.loggedOut);
      manager.dispose();
    });

    test('relock is a no-op (status stays authenticated)', () async {
      final AuthSessionManager manager =
          build(persistentAuthEnabled: false);
      api
        ..isNewUser = false
        ..pinIsSet = true;
      await manager.verifyOtp('+91999', '1234'); // authenticated
      expect(manager.status, AuthStatus.authenticated);

      await manager.relock();

      // Never re-locks to a PIN that cannot be unlocked on the real path.
      expect(manager.status, AuthStatus.authenticated);
      manager.dispose();
    });
  });

  group('persistent-auth layer ON (mock / staging contrast)', () {
    test('a new user (pinSet=false) -> locked (must set a PIN)', () async {
      final AuthSessionManager manager = build(persistentAuthEnabled: true);
      api
        ..isNewUser = true
        ..pinIsSet = false;

      await manager.verifyOtp('+91999', '1234');

      expect(manager.status, AuthStatus.locked);
      manager.dispose();
    });
  });
}

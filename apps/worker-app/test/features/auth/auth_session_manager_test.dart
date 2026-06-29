import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';

import '../../core/auth/fakes.dart';

/// A scripted [AuthApi] over the real [SecureTokenStore] surface — no network.
/// It records calls and writes the store exactly as the live/mock path would,
/// so the manager's BRIDGE into SessionRepository can be asserted end-to-end.
class ScriptAuthApi extends AuthApi {
  ScriptAuthApi(this._store) : super.withoutClient();

  final SecureTokenStore _store;

  bool pinIsSet = false;
  bool isNewUser = true;
  AuthFailure? throwOnVerify;
  AuthFailure? throwOnPinVerify;
  int logoutCalls = 0;
  int revokeCalls = 0;

  AuthTokens _mint(String access, String refresh) => AuthTokens(
        access: access,
        refresh: refresh,
        accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)),
      );

  @override
  Future<OtpRequestResult> otpRequest(String phoneE164) async =>
      const OtpRequestResult(resendIn: Duration(seconds: 30));

  @override
  Future<OtpVerifyResult> otpVerify(String phone, String otp) async {
    if (throwOnVerify != null) throw throwOnVerify!;
    final AuthTokens tokens = _mint('access-otp', 'refresh-1');
    await _store.saveTokens(
      refreshToken: tokens.refresh,
      accessExpiresAt: tokens.accessExpiresAt,
      accessToken: tokens.access,
    );
    await _store.writeWorkerId('worker-9');
    await _store.writePinSet(pinIsSet);
    return OtpVerifyResult(
      workerId: 'worker-9',
      isNewUser: isNewUser,
      pinSet: pinIsSet,
      tokens: tokens,
    );
  }

  @override
  Future<void> pinSet(String pin) async {
    pinIsSet = true;
    await _store.writePinSet(true);
  }

  @override
  Future<AuthTokens> pinVerify(String pin, {required String refreshToken}) async {
    if (throwOnPinVerify != null) throw throwOnPinVerify!;
    final AuthTokens tokens = _mint('access-unlock', 'refresh-2');
    await _store.saveTokens(
      refreshToken: tokens.refresh,
      accessExpiresAt: tokens.accessExpiresAt,
      accessToken: tokens.access,
    );
    return tokens;
  }

  @override
  Future<AuthTokens> tokenRefresh(String refreshToken) async {
    final AuthTokens tokens = _mint('access-refresh', 'refresh-3');
    await _store.saveTokens(
      refreshToken: tokens.refresh,
      accessExpiresAt: tokens.accessExpiresAt,
      accessToken: tokens.access,
    );
    return tokens;
  }

  @override
  Future<void> logout() async => logoutCalls++;

  @override
  Future<List<AuthDevice>> listDevices() async => <AuthDevice>[
        AuthDevice(
            deviceId: 'd1',
            label: 'This phone',
            lastSeenAt: DateTime.now(),
            current: true),
      ];

  @override
  Future<void> revokeDevice(String deviceId) async => revokeCalls++;
}

void main() {
  late FakeSecureStore secureBacking;
  late SecureTokenStore store;
  late SessionRepository session;
  late ReauthSignal reauth;
  late ScriptAuthApi api;
  late AuthSessionManager manager;

  AuthSessionManager build() => AuthSessionManager(
        authApi: api,
        tokenStore: store,
        session: session,
        reauthSignal: reauth,
        persistentAuthEnabled: true,
      );

  setUp(() {
    secureBacking = FakeSecureStore();
    store = SecureTokenStore(secureBacking);
    session = SessionRepository();
    reauth = ReauthSignal();
    api = ScriptAuthApi(store);
    manager = build();
  });

  tearDown(() {
    manager.dispose();
    reauth.dispose();
  });

  group('bootstrap (cold start)', () {
    test('WITH a remembered refresh token -> locked (needs PIN)', () async {
      await store.writeRefreshToken('remembered');
      final AuthStatus s = await manager.bootstrap();
      expect(s, AuthStatus.locked);
      expect(manager.status, AuthStatus.locked);
      expect(manager.isReady, isTrue);
    });

    test('WITHOUT a refresh token -> loggedOut (needs phone)', () async {
      final AuthStatus s = await manager.bootstrap();
      expect(s, AuthStatus.loggedOut);
      expect(manager.status, AuthStatus.loggedOut);
    });
  });

  group('verifyOtp bridges into SessionRepository', () {
    test('new user (no PIN) -> locked, but the token is already bridged',
        () async {
      api
        ..isNewUser = true
        ..pinIsSet = false;
      final OtpVerifyResult r = await manager.verifyOtp('+91999', '1234');
      expect(r.isNewUser, isTrue);
      expect(manager.status, AuthStatus.locked);
      // Bridge: the legacy session now carries the fresh access token + worker.
      expect(session.sessionToken, 'access-otp');
      expect(session.workerId, 'worker-9');
    });

    test('returning user with a PIN -> authenticated + bridged', () async {
      api
        ..isNewUser = false
        ..pinIsSet = true;
      await manager.verifyOtp('+91999', '1234');
      expect(manager.status, AuthStatus.authenticated);
      expect(session.sessionToken, 'access-otp');
    });

    test('bad OTP throws AuthFailure and does not authenticate', () async {
      api.throwOnVerify = const AuthFailure(AuthErrorCode.otpInvalid);
      await expectLater(
        manager.verifyOtp('+91999', '0000'),
        throwsA(isA<AuthFailure>()),
      );
      expect(manager.status, AuthStatus.loggedOut);
      expect(session.sessionToken, isNull);
    });
  });

  group('unlockWithPin', () {
    test('mints fresh tokens, RE-BRIDGES, and authenticates', () async {
      await store.writeRefreshToken('refresh-1');
      await store.writeWorkerId('worker-9');
      await manager.bootstrap(); // locked

      await manager.unlockWithPin('7416');

      expect(manager.status, AuthStatus.authenticated);
      // Re-bridge: the session bearer is the freshly minted unlock token, so the
      // worker stays logged in and skips re-profiling.
      expect(session.sessionToken, 'access-unlock');
      expect(session.workerId, 'worker-9');
    });

    test('PIN_INVALID throws and stays locked', () async {
      await store.writeRefreshToken('refresh-1');
      await manager.bootstrap();
      api.throwOnPinVerify =
          const AuthFailure(AuthErrorCode.pinInvalid, attemptsLeft: 2);

      await expectLater(
        manager.unlockWithPin('0000'),
        throwsA(isA<AuthFailure>()),
      );
      expect(manager.status, AuthStatus.locked);
    });

    test('no refresh token -> forces a fresh OTP login', () async {
      await expectLater(
        manager.unlockWithPin('7416'),
        throwsA(isA<AuthFailure>()),
      );
      expect(manager.status, AuthStatus.loggedOut);
    });
  });

  group('relock (lifecycle)', () {
    test('with a remembered token -> locks and drops the in-memory access token',
        () async {
      api
        ..isNewUser = false
        ..pinIsSet = true;
      await manager.verifyOtp('+91999', '1234'); // authenticated
      expect(manager.status, AuthStatus.authenticated);

      await manager.relock();

      expect(manager.status, AuthStatus.locked);
      expect(store.accessToken, isNull); // no live bearer while locked
    });

    test('with NO remembered token -> no-op (cannot lock a logged-out app)',
        () async {
      await manager.relock();
      // Default status stays loggedOut; relock did nothing.
      expect(manager.status, AuthStatus.loggedOut);
    });
  });

  group('logout', () {
    test('revokes server-side, wipes BOTH stores, routes to loggedOut',
        () async {
      api
        ..isNewUser = false
        ..pinIsSet = true;
      await manager.verifyOtp('+91999', '1234');

      await manager.logout();

      expect(api.logoutCalls, 1);
      expect(manager.status, AuthStatus.loggedOut);
      expect(session.sessionToken, isNull);
      expect(await store.readRefreshToken(), isNull);
    });

    test('offline-safe: a failed revoke still wipes locally', () async {
      // A manager whose server-side logout throws — the local wipe must still
      // run (offline-safe). Seed an authenticated session via OTP verify first.
      final AuthSessionManager m = AuthSessionManager(
        authApi: _ThrowingLogoutApi(store)
          ..isNewUser = false
          ..pinIsSet = true,
        tokenStore: store,
        session: session,
        reauthSignal: reauth,
        persistentAuthEnabled: true,
      );
      await m.verifyOtp('+91999', '1234');

      await m.logout(); // must not throw despite the failing revoke

      expect(m.status, AuthStatus.loggedOut);
      expect(await store.readRefreshToken(), isNull);
      expect(session.sessionToken, isNull);
      m.dispose();
    });
  });

  group('reauth signal', () {
    test('a fired ReauthSignal clears the session and forces loggedOut',
        () async {
      api
        ..isNewUser = false
        ..pinIsSet = true;
      await manager.verifyOtp('+91999', '1234'); // authenticated + bridged
      expect(session.sessionToken, isNotNull);

      reauth.requireReauth();
      await Future<void>.delayed(Duration.zero); // let the stream listener run

      expect(manager.status, AuthStatus.loggedOut);
      expect(session.sessionToken, isNull);
    });
  });

  test('revokeDevice delegates to the api', () async {
    await manager.revokeDevice('other');
    expect(api.revokeCalls, 1);
  });
}

/// An api whose logout throws — proves the offline-safe local wipe.
class _ThrowingLogoutApi extends ScriptAuthApi {
  _ThrowingLogoutApi(super.store);

  @override
  Future<void> logout() async => throw const AuthFailure(AuthErrorCode.network);
}

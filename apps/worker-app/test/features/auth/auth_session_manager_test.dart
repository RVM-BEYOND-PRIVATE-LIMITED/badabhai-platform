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

  /// TD62 — the scripted `consent_accepted` the fake server returns on both
  /// verify responses. Defaults null (old-server shape: field absent).
  bool? consentAccepted;
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
      consentAccepted: consentAccepted,
    );
  }

  @override
  Future<void> pinSet(String pin) async {
    pinIsSet = true;
    await _store.writePinSet(true);
  }

  @override
  Future<PinVerifyResult> pinVerify(String pin,
      {required String refreshToken}) async {
    if (throwOnPinVerify != null) throw throwOnPinVerify!;
    final AuthTokens tokens = _mint('access-unlock', 'refresh-2');
    await _store.saveTokens(
      refreshToken: tokens.refresh,
      accessExpiresAt: tokens.accessExpiresAt,
      accessToken: tokens.access,
    );
    return PinVerifyResult(tokens: tokens, consentAccepted: consentAccepted);
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
          id: 'd1',
          platform: 'android',
          model: 'This phone',
          appVersion: '0.1.0',
          trustedAt: DateTime.now(),
          lastSeenAt: DateTime.now(),
          isCurrent: true,
        ),
      ];

  @override
  Future<void> revokeDevice(String deviceId) async => revokeCalls++;

  bool resetRequested = false;
  bool resetConfirmed = false;

  @override
  Future<void> pinResetRequest(String phoneE164) async => resetRequested = true;

  @override
  Future<void> pinResetConfirm(String phone, String otp, String pin) async =>
      resetConfirmed = true;
}

/// An api that mints tokens but does NOT write [SecureTokenStore] — proves the
/// MANAGER (GAP A), not the api/mock, is what persists the tokens.
class _NonPersistingApi extends AuthApi {
  _NonPersistingApi() : super.withoutClient();

  AuthTokens _mint(String access, String refresh) => AuthTokens(
        access: access,
        refresh: refresh,
        accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)),
      );

  @override
  Future<OtpVerifyResult> otpVerify(String phone, String otp) async =>
      OtpVerifyResult(
        workerId: 'worker-np',
        isNewUser: false,
        pinSet: true,
        tokens: _mint('access-otp-np', 'refresh-otp-np'),
      );

  @override
  Future<PinVerifyResult> pinVerify(String pin,
          {required String refreshToken}) async =>
      PinVerifyResult(tokens: _mint('access-pin-np', 'refresh-pin-np'));

  @override
  Future<AuthTokens> tokenRefresh(String refreshToken) async =>
      _mint('access-ref-np', 'refresh-ref-np');
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

    // #352 — `locked` alone cannot distinguish "enter your PIN" from "choose
    // your first PIN". pin_set was only ever written by MockAuthApi, so on the
    // real path a worker who killed the app on Set-PIN cold-started into
    // Enter-PIN and was asked for a PIN that never existed.
    group('pin_set drives locked routing (#352)', () {
      test('refresh token but NO pin_set -> locked with pinSet == false',
          () async {
        await store.writeRefreshToken('remembered');
        // pin_set is absent — exactly the state left by the REAL AuthApi, which
        // (unlike MockAuthApi) never wrote the key.
        final AuthStatus s = await manager.bootstrap();

        expect(s, AuthStatus.locked);
        expect(manager.pinSet, isFalse,
            reason: 'the router must send this worker to SET a PIN, not enter one');
      });

      test('refresh token AND pin_set -> locked with pinSet == true', () async {
        await store.writeRefreshToken('remembered');
        await store.writePinSet(true);
        final AuthStatus s = await manager.bootstrap();

        expect(s, AuthStatus.locked);
        expect(manager.pinSet, isTrue);
      });

      test('verifyOtp persists the SERVER pin_set on the real path', () async {
        // The real AuthApi does NOT touch the store — only the manager does.
        final _NoStoreWriteApi realish = _NoStoreWriteApi(store)..pinIsSet = true
          ..isNewUser = false;
        final AuthSessionManager m = AuthSessionManager(
          authApi: realish,
          tokenStore: store,
          session: session,
          reauthSignal: reauth,
          persistentAuthEnabled: true,
        );
        addTearDown(m.dispose);

        await m.verifyOtp('+910000000000', '123456');

        expect(await store.readPinSet(), isTrue,
            reason: 'the manager, not the api, must persist pin_set');
        expect(m.pinSet, isTrue);
      });

      test('setPin records that a PIN now exists', () async {
        final _NoStoreWriteApi realish = _NoStoreWriteApi(store);
        final AuthSessionManager m = AuthSessionManager(
          authApi: realish,
          tokenStore: store,
          session: session,
          reauthSignal: reauth,
          persistentAuthEnabled: true,
        );
        addTearDown(m.dispose);

        expect(m.pinSet, isFalse);
        await m.setPin('1379');

        expect(m.pinSet, isTrue);
        expect(await store.readPinSet(), isTrue,
            reason: 'a cold start after setPin must go to enter-PIN');
      });

      test('logout clears pinSet so the next worker is not mis-routed',
          () async {
        await store.writeRefreshToken('remembered');
        await store.writePinSet(true);
        await manager.bootstrap();
        expect(manager.pinSet, isTrue);

        await manager.logout();

        expect(manager.pinSet, isFalse);
        expect(await store.readPinSet(), isFalse);
      });
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

    test('a failed PIN throws NEUTRAL pinVerifyFailed and stays locked',
        () async {
      await store.writeRefreshToken('refresh-1');
      await manager.bootstrap();
      api.throwOnPinVerify =
          const AuthFailure(AuthErrorCode.pinVerifyFailed);

      await expectLater(
        manager.unlockWithPin('0000'),
        throwsA(isA<AuthFailure>().having(
            (AuthFailure f) => f.code, 'code', AuthErrorCode.pinVerifyFailed)),
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

    // #368 — relock claimed "no authed call slips through while locked" but only
    // nulled AuthedClient's copy. The SAME token had been bridged into
    // SessionRepository, and that is the bearer every legacy worker-scoped call
    // actually sends, so a request queued before the pause still authenticated
    // behind the PIN screen.
    group('the bridged bearer is fenced too (#368)', () {
      test('relock drops SessionRepository.sessionToken, not just the store',
          () async {
        api
          ..isNewUser = false
          ..pinIsSet = true;
        await manager.verifyOtp('+91999', '1234');
        expect(session.sessionToken, isNotNull, reason: 'bridged on login');

        await manager.relock();

        expect(store.accessToken, isNull);
        expect(session.sessionToken, isNull,
            reason: 'the bearer legacy ApiClient calls actually send');
      });

      test('relock keeps the ids so unlock re-bridges onto the same worker',
          () async {
        api
          ..isNewUser = false
          ..pinIsSet = true;
        await manager.verifyOtp('+91999', '1234');
        session.setSession('chat-session-1');

        await manager.relock();

        // Only the bearer is fenced — the worker and the open chat session must
        // survive the lock.
        expect(session.workerId, 'worker-9');
        expect(session.sessionId, 'chat-session-1');
      });

      test('unlockWithPin restores a fresh bearer after the fence', () async {
        api
          ..isNewUser = false
          ..pinIsSet = true;
        await manager.verifyOtp('+91999', '1234');
        await manager.relock();
        expect(session.sessionToken, isNull);

        await manager.unlockWithPin('1379');

        expect(manager.status, AuthStatus.authenticated);
        expect(session.sessionToken, 'access-unlock',
            reason: 'unlock re-bridges a freshly minted token');
      });
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

  group('GAP A: the MANAGER persists tokens to SecureTokenStore', () {
    late AuthSessionManager m;
    setUp(() {
      m = AuthSessionManager(
        authApi: _NonPersistingApi(),
        tokenStore: store,
        session: session,
        reauthSignal: reauth,
        persistentAuthEnabled: true,
      );
    });
    tearDown(() => m.dispose());

    test('verifyOtp persists the refresh token + worker id + access expiry',
        () async {
      await m.verifyOtp('+91999', '1234');
      expect(await store.readRefreshToken(), 'refresh-otp-np');
      expect(await store.readWorkerId(), 'worker-np');
      expect(store.accessToken, 'access-otp-np');
      expect(await store.readAccessExpiresAt(), isNotNull);
    });

    test('unlockWithPin persists the ROTATED tokens', () async {
      await store.writeRefreshToken('seed-refresh');
      await store.writeWorkerId('worker-np');
      await m.bootstrap(); // locked

      await m.unlockWithPin('7416');

      expect(await store.readRefreshToken(), 'refresh-pin-np');
      expect(store.accessToken, 'access-pin-np');
    });

    test('refresh persists the ROTATED tokens', () async {
      await store.writeRefreshToken('seed-refresh');
      await m.bootstrap();

      await m.refresh();

      expect(await store.readRefreshToken(), 'refresh-ref-np');
      expect(store.accessToken, 'access-ref-np');
    });

    test('with the layer OFF, verifyOtp persists NOTHING (main-like)', () async {
      final AuthSessionManager off = AuthSessionManager(
        authApi: _NonPersistingApi(),
        tokenStore: store,
        session: session,
        reauthSignal: reauth,
        persistentAuthEnabled: false,
      );
      await off.verifyOtp('+91999', '1234');
      expect(await store.readRefreshToken(), isNull);
      expect(await store.readWorkerId(), isNull);
      off.dispose();
    });
  });

  group('TD62: consentAccepted tri-state + markConsentAccepted', () {
    test('verifyOtp populates consentAccepted=false from the server signal',
        () async {
      api
        ..isNewUser = false
        ..pinIsSet = true
        ..consentAccepted = false;
      await manager.verifyOtp('+91999', '1234');
      expect(manager.status, AuthStatus.authenticated);
      expect(manager.consentAccepted, isFalse);
    });

    test('verifyOtp with an OLD server (field absent) leaves it null', () async {
      api
        ..isNewUser = false
        ..pinIsSet = true
        ..consentAccepted = null;
      await manager.verifyOtp('+91999', '1234');
      expect(manager.consentAccepted, isNull);
    });

    test('unlockWithPin populates consentAccepted from the PIN response',
        () async {
      await store.writeRefreshToken('refresh-1');
      await store.writeWorkerId('worker-9');
      await manager.bootstrap();
      api.consentAccepted = true;

      await manager.unlockWithPin('7416');

      expect(manager.consentAccepted, isTrue);
    });

    test('markConsentAccepted flips false -> true and notifies listeners',
        () async {
      api
        ..isNewUser = false
        ..pinIsSet = true
        ..consentAccepted = false;
      await manager.verifyOtp('+91999', '1234');
      expect(manager.consentAccepted, isFalse);

      int notifies = 0;
      manager.addListener(() => notifies++);
      manager.markConsentAccepted();

      expect(manager.consentAccepted, isTrue);
      expect(notifies, 1);
      // Idempotent: a second call does not re-notify.
      manager.markConsentAccepted();
      expect(notifies, 1);
    });

    test('logout clears consentAccepted back to null (unknown)', () async {
      api
        ..isNewUser = false
        ..pinIsSet = true
        ..consentAccepted = true;
      await manager.verifyOtp('+91999', '1234');
      expect(manager.consentAccepted, isTrue);

      await manager.logout();

      expect(manager.consentAccepted, isNull);
    });

    test('a fired ReauthSignal clears consentAccepted back to null', () async {
      api
        ..isNewUser = false
        ..pinIsSet = true
        ..consentAccepted = true;
      await manager.verifyOtp('+91999', '1234');

      reauth.requireReauth();
      await Future<void>.delayed(Duration.zero);

      expect(manager.consentAccepted, isNull);
    });
  });

  group('GAP C: forgot-PIN drives the dedicated reset endpoints', () {
    test('requestPinReset calls pin/reset/request', () async {
      await manager.requestPinReset('+91999');
      expect(api.resetRequested, isTrue);
    });

    test('confirmPinReset → locked when a refresh token survives', () async {
      await store.writeRefreshToken('survives');
      await manager.confirmPinReset('+91999', '123456', '4821');
      expect(api.resetConfirmed, isTrue);
      expect(manager.status, AuthStatus.locked);
    });

    test('confirmPinReset → loggedOut when NO refresh token remains', () async {
      await manager.confirmPinReset('+91999', '123456', '4821');
      expect(manager.status, AuthStatus.loggedOut);
    });

    test('confirmPinReset rethrows a bad-OTP AuthFailure', () async {
      final AuthSessionManager m = AuthSessionManager(
        authApi: _ThrowingResetApi(store),
        tokenStore: store,
        session: session,
        reauthSignal: reauth,
        persistentAuthEnabled: true,
      );
      await expectLater(
        m.confirmPinReset('+91999', '000000', '4821'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.otpInvalid)),
      );
      m.dispose();
    });
  });
}

/// A reset api whose confirm throws an OTP-invalid failure (401 path).
class _ThrowingResetApi extends ScriptAuthApi {
  _ThrowingResetApi(super.store);

  @override
  Future<void> pinResetConfirm(String phone, String otp, String pin) async =>
      throw const AuthFailure(AuthErrorCode.otpInvalid);
}

/// An api whose logout throws — proves the offline-safe local wipe.
class _ThrowingLogoutApi extends ScriptAuthApi {
  _ThrowingLogoutApi(super.store);

  @override
  Future<void> logout() async => throw const AuthFailure(AuthErrorCode.network);
}

/// An api that models the REAL [AuthApi]: it returns the server's flags but
/// NEVER writes SecureTokenStore.
///
/// [ScriptAuthApi] writes `pin_set` itself (mirroring MockAuthApi) — which is
/// exactly what hid #352: on the real path only the mock ever wrote that key, so
/// nothing persisted it and bootstrap could not tell "has a PIN" from "never set
/// one". Persisting it is the MANAGER's job, and these fakes must not do it for
/// the manager or the regression is untestable.
class _NoStoreWriteApi extends ScriptAuthApi {
  _NoStoreWriteApi(super.store);

  @override
  Future<OtpVerifyResult> otpVerify(String phone, String otp) async {
    if (throwOnVerify != null) throw throwOnVerify!;
    return OtpVerifyResult(
      workerId: 'worker-9',
      isNewUser: isNewUser,
      pinSet: pinIsSet,
      tokens: AuthTokens(
        access: 'access-otp',
        refresh: 'refresh-1',
        accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)),
      ),
      consentAccepted: consentAccepted,
    );
  }

  @override
  Future<void> pinSet(String pin) async {
    // The real endpoint just 204s — no client-side store write.
    pinIsSet = true;
  }
}

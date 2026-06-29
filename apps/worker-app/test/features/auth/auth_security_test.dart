// Security asserts for persistent auth (CLAUDE.md §2):
//  - the PIN is NEVER logged, persisted, or held by the session manager,
//  - the refresh token lives ONLY in secure storage, never in plain prefs,
//  - nothing prints a token.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';

import '../../core/auth/fakes.dart';
import 'auth_session_manager_test.dart' show ScriptAuthApi;

void main() {
  test('the PIN is never persisted anywhere and never held by the manager',
      () async {
    final FakeSecureStore secure = FakeSecureStore();
    final FakePrefs prefs = FakePrefs();
    final SecureTokenStore store = SecureTokenStore(secure);
    final ReauthSignal reauth = ReauthSignal();
    final ScriptAuthApi api = ScriptAuthApi(store)
      ..isNewUser = false
      ..pinIsSet = true;
    final AuthSessionManager manager = AuthSessionManager(
      authApi: api,
      tokenStore: store,
      session: SessionRepository(),
      reauthSignal: reauth,
    );

    const String secretPin = '7416';
    await manager.verifyOtp('+91999', '1234');
    await store.writeRefreshToken('refresh-1'); // simulate remembered device
    await manager.unlockWithPin(secretPin);

    // The PIN must appear in NO persisted value (secure or plain).
    for (final String v in <String>[...secure.map.values, ...prefs.map.values]) {
      expect(v.contains(secretPin), isFalse,
          reason: 'PIN leaked into storage: $v');
    }
    // The manager exposes no PIN field; its toString must not echo one either.
    expect(manager.toString().contains(secretPin), isFalse);

    manager.dispose();
    reauth.dispose();
  });

  test('the refresh token lives ONLY in secure storage (never plain prefs)',
      () async {
    final FakeSecureStore secure = FakeSecureStore();
    final FakePrefs prefs = FakePrefs();
    final SecureTokenStore store = SecureTokenStore(secure);

    await store.saveTokens(
      refreshToken: 'super-secret-refresh',
      accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)),
      accessToken: 'access',
    );

    // Present in secure storage…
    expect(
      secure.map.values.any((String v) => v.contains('super-secret-refresh')),
      isTrue,
    );
    // …and ABSENT from the plain prefs store.
    expect(
      prefs.map.values.any((String v) => v.contains('super-secret-refresh')),
      isFalse,
    );
  });

  test('the access token is in memory only — never written to the store',
      () async {
    final FakeSecureStore secure = FakeSecureStore();
    final SecureTokenStore store = SecureTokenStore(secure);

    await store.saveTokens(
      refreshToken: 'r',
      accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)),
      accessToken: 'live-access-token',
    );

    expect(store.accessToken, 'live-access-token'); // in memory
    // The access token must NOT be persisted to disk.
    expect(
      secure.map.values.any((String v) => v.contains('live-access-token')),
      isFalse,
    );
  });

  test('a stdout capture during the auth flow prints no token', () async {
    final FakeSecureStore secure = FakeSecureStore();
    final SecureTokenStore store = SecureTokenStore(secure);
    final ReauthSignal reauth = ReauthSignal();
    final ScriptAuthApi api = ScriptAuthApi(store)
      ..isNewUser = false
      ..pinIsSet = true;
    final AuthSessionManager manager = AuthSessionManager(
      authApi: api,
      tokenStore: store,
      session: SessionRepository(),
      reauthSignal: reauth,
    );

    final List<String> printed = <String>[];
    await runZoned(
      () async {
        await manager.verifyOtp('+91999', '1234');
        await store.writeRefreshToken('refresh-1');
        await manager.unlockWithPin('7416');
        await manager.logout();
      },
      zoneSpecification: ZoneSpecification(
        print: (_, __, ___, String line) => printed.add(line),
      ),
    );

    final String joined = printed.join('\n');
    for (final String token in <String>[
      '7416',
      'access-otp',
      'access-unlock',
      'refresh-1',
      'refresh-2',
    ]) {
      expect(joined.contains(token), isFalse,
          reason: 'token "$token" leaked to stdout');
    }

    manager.dispose();
    reauth.dispose();
  });
}

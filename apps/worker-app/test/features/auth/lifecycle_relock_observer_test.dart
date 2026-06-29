import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/lifecycle_relock_observer.dart';

import '../../core/auth/fakes.dart';
import 'auth_session_manager_test.dart' show ScriptAuthApi;

/// Builds an AUTHENTICATED manager (OTP verify with a PIN) over fakes, plus its
/// store/api so the test can manipulate the remembered refresh token.
Future<_Ctx> _authenticated() async {
  final FakeSecureStore backing = FakeSecureStore();
  final SecureTokenStore store = SecureTokenStore(backing);
  final SessionRepository session = SessionRepository();
  final ReauthSignal reauth = ReauthSignal();
  final ScriptAuthApi api = ScriptAuthApi(store)
    ..isNewUser = false
    ..pinIsSet = true;
  final AuthSessionManager manager = AuthSessionManager(
    authApi: api,
    tokenStore: store,
    session: session,
    reauthSignal: reauth,
    persistentAuthEnabled: true,
  );
  await manager.verifyOtp('+91999', '1234');
  return _Ctx(manager, store, reauth);
}

class _Ctx {
  _Ctx(this.manager, this.store, this.reauth);
  final AuthSessionManager manager;
  final SecureTokenStore store;
  final ReauthSignal reauth;
  void dispose() {
    manager.dispose();
    reauth.dispose();
  }
}

void main() {
  const Duration window = Duration(minutes: 5);

  test('background > window -> re-locks to PIN', () async {
    final _Ctx ctx = await _authenticated();
    DateTime now = DateTime(2026, 1, 1, 12, 0, 0);
    final LifecycleRelockObserver obs =
        LifecycleRelockObserver(ctx.manager, window: window, now: () => now);

    expect(ctx.manager.status, AuthStatus.authenticated);

    obs.didChangeAppLifecycleState(AppLifecycleState.paused);
    now = now.add(const Duration(minutes: 6)); // past the window
    obs.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await Future<void>.delayed(Duration.zero);

    expect(ctx.manager.status, AuthStatus.locked);
    ctx.dispose();
  });

  test('background < window (active use) -> NEVER asks the PIN', () async {
    final _Ctx ctx = await _authenticated();
    DateTime now = DateTime(2026, 1, 1, 12, 0, 0);
    final LifecycleRelockObserver obs =
        LifecycleRelockObserver(ctx.manager, window: window, now: () => now);

    obs.didChangeAppLifecycleState(AppLifecycleState.paused);
    now = now.add(const Duration(seconds: 30)); // a quick glance away
    obs.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await Future<void>.delayed(Duration.zero);

    expect(ctx.manager.status, AuthStatus.authenticated);
    ctx.dispose();
  });

  test('resume without a preceding pause -> no-op', () async {
    final _Ctx ctx = await _authenticated();
    final LifecycleRelockObserver obs =
        LifecycleRelockObserver(ctx.manager, window: window);

    obs.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await Future<void>.delayed(Duration.zero);

    expect(ctx.manager.status, AuthStatus.authenticated);
    ctx.dispose();
  });

  test('a logged-out app is never re-locked (nothing to protect)', () async {
    final FakeSecureStore backing = FakeSecureStore();
    final SecureTokenStore store = SecureTokenStore(backing);
    final ReauthSignal reauth = ReauthSignal();
    final AuthSessionManager manager = AuthSessionManager(
      authApi: ScriptAuthApi(store),
      tokenStore: store,
      session: SessionRepository(),
      reauthSignal: reauth,
      persistentAuthEnabled: true,
    );
    await manager.bootstrap(); // loggedOut (no token)

    DateTime now = DateTime(2026, 1, 1, 12, 0, 0);
    final LifecycleRelockObserver obs =
        LifecycleRelockObserver(manager, window: window, now: () => now);
    obs.didChangeAppLifecycleState(AppLifecycleState.paused);
    now = now.add(const Duration(hours: 2));
    obs.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await Future<void>.delayed(Duration.zero);

    expect(manager.status, AuthStatus.loggedOut);
    manager.dispose();
    reauth.dispose();
  });
}

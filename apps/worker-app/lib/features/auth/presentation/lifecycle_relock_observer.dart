import 'package:flutter/widgets.dart';

import '../domain/auth_session_manager.dart';
import '../domain/relock_config.dart';

/// Watches app lifecycle and re-locks to the PIN screen after the app has been
/// backgrounded longer than [RelockConfig.relockAfter] (PASS 2 §5).
///
/// On [AppLifecycleState.paused] it records a timestamp; on
/// [AppLifecycleState.resumed] it compares the gap and, if it exceeds the
/// window, calls [AuthSessionManager.relock] — which only re-locks when a
/// refresh token is remembered AND the worker is currently authenticated. During
/// active use (valid access / silent refresh) the app is never backgrounded long
/// enough, so the PIN is never asked. Cold start does not run through here at
/// all — it goes through `bootstrap()`.
///
/// A pure [WidgetsBindingObserver]; the app's root widget registers/unregisters
/// it. [now] is injectable so a test can drive the clock deterministically.
class LifecycleRelockObserver with WidgetsBindingObserver {
  LifecycleRelockObserver(
    this._manager, {
    Duration window = RelockConfig.relockAfter,
    DateTime Function() now = DateTime.now,
  })  : _window = window,
        _now = now;

  final AuthSessionManager _manager;
  final Duration _window;
  final DateTime Function() _now;

  DateTime? _pausedAt;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
        // Only the authenticated app is worth re-locking; a logged-out / already
        // locked app has nothing to protect behind the PIN.
        if (_manager.status == AuthStatus.authenticated) {
          _pausedAt = _now();
        }
      case AppLifecycleState.resumed:
        final DateTime? paused = _pausedAt;
        _pausedAt = null;
        if (paused == null) return;
        if (_now().difference(paused) > _window) {
          _manager.relock();
        }
      case AppLifecycleState.inactive:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        break;
    }
  }
}

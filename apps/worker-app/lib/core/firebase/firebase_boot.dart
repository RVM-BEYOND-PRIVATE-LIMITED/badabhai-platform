import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';

/// The ONE `Firebase.initializeApp()` of this process, shared by every Firebase
/// consumer (Crashlytics and Remote Config).
///
/// WHY THIS EXISTS. Every `Firebase*.instance` getter resolves `Firebase.app()`,
/// and that THROWS (`core/no-app`) until an `initializeApp()` has COMPLETED: the
/// Dart-side app registry is filled only by its platform round trip. Crashlytics
/// awaited its own init, but Remote Config started from the next post-frame
/// callback while that round trip was still in flight, so its first line threw
/// on every cold start. `init()` swallowed the throw by design, and every
/// Remote Config lever stayed on its compiled-in default in production: a
/// console flip, including `worker_chat_companion_enabled`, never reached a
/// device.
///
/// Every consumer awaits this before touching its `instance`, and they all
/// share one attempt. It is time-boxed the way the crash reporter always was: on
/// a non-GMS / AOSP ROM the native init can hang instead of failing.
abstract final class FirebaseBoot {
  static const Duration timeout = Duration(seconds: 8);

  static Future<void>? _boot;

  /// Completes once Firebase is initialized, or throws when it cannot be (no
  /// plugin, no config, a hung native init). A failed attempt is forgotten, so
  /// a later caller tries again instead of inheriting the failure.
  static Future<void> ensureInitialized() {
    return _boot ??= _initialize().then(
      (_) {},
      onError: (Object error, StackTrace stack) {
        _boot = null;
        Error.throwWithStackTrace(error, stack);
      },
    );
  }

  static Future<void> _initialize() async {
    final Future<Object?> Function()? stub = debugInitializer;
    await (stub != null ? stub() : Firebase.initializeApp()).timeout(timeout);
  }

  /// Replaces `Firebase.initializeApp` in a test. The plugin is not registered
  /// under `flutter test`, so without this every call fails.
  @visibleForTesting
  static Future<Object?> Function()? debugInitializer;

  /// Forgets the shared attempt and the test initializer. Test-only.
  @visibleForTesting
  static void debugReset() {
    _boot = null;
    debugInitializer = null;
  }
}

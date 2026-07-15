import 'dart:async';
import 'dart:isolate';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show MissingPluginException;

/// App-wide crash reporting, wired to **Firebase Crashlytics** (FlutterFire).
///
/// This is the ONLY thing that captures the ~95% of crashes that are Dart /
/// Flutter errors — native Crashlytics alone sees only JVM/NDK crashes, which
/// Flutter code never produces. Wire it from `main()` before `runApp`.
///
/// ## Hard design rules (do not relax)
///
/// 1. **Fail-closed / never crash OR hang.** Firebase auto-init OR any
///    Crashlytics call can throw — or, on a pathological device, *never return*
///    — on non-GMS / low-end / mis-configured devices (Huawei w/o Google Play
///    Services, some AOSP/China ROMs, bare emulators, iOS without a bundled
///    `GoogleService-Info.plist`). Init is both try/caught AND time-bounded, and
///    every report call swallows sync throws and async rejections, so a
///    reporting failure degrades to "no reporting" — it must NEVER take the app
///    down or wedge the first frame. This is the fix for "the crash analytics
///    crashes itself".
/// 2. **No silent swallowing when reporting is off.** The Flutter/async error
///    handlers are installed ONLY after Firebase initialises. On a device where
///    init fails, the app keeps Flutter's default error behaviour instead of
///    eating errors invisibly. In debug, async errors are still surfaced.
/// 3. **No raw PII (BadaBhai invariant #2).** Only route names, an opaque user
///    id, and non-PII reasons/keys are ever attached. Never a phone, name,
///    address, OTP, or token. Device model / OS / RAM are auto-captured by
///    Crashlytics itself — that is safe metadata, not PII. (Do not embed PII in
///    exception *messages* either — those ride along to the report.)
class CrashReporter {
  CrashReporter._();

  static bool _ready = false;
  static String _ownPackage = '';

  /// True once Firebase initialised and Crashlytics is accepting reports.
  static bool get isReady => _ready;

  /// Initialise Firebase + install Crashlytics as the sink for every Dart error
  /// channel. Call once from `main()` right after
  /// `WidgetsFlutterBinding.ensureInitialized()` and before `runApp`.
  ///
  /// [appName] tags every report (e.g. `payer-app`). [ownPackage] is this app's
  /// Dart package name (pubspec `name:`) — used only to classify a crash as our
  /// code vs a third-party package.
  ///
  /// Returns normally on ALL devices: on init failure OR a hung native init it
  /// sets [isReady] false, logs in debug, and returns — the caller keeps
  /// running and the first frame is never blocked.
  static Future<void> init({
    required String appName,
    required String ownPackage,
  }) async {
    _ownPackage = ownPackage;
    try {
      // No options: reads the native config already in the project (Android:
      // google-services.json; iOS: GoogleService-Info.plist). Time-bounded so a
      // native init that DEADLOCKS instead of erroring can't wedge the first
      // frame — a TimeoutException is caught below exactly like any init error.
      await Firebase.initializeApp().timeout(const Duration(seconds: 8));
      // Collect in release only by default. In debug, errors go to the console
      // / debugger and must not pollute the live dashboard.
      await FirebaseCrashlytics.instance
          .setCrashlyticsCollectionEnabled(!kDebugMode)
          .timeout(const Duration(seconds: 4));
      await FirebaseCrashlytics.instance
          .setCustomKey('app', appName)
          .timeout(const Duration(seconds: 4));
      _ready = true;
    } catch (error, stack) {
      _ready = false;
      // NEVER rethrow — a reporter that cannot start must not crash the app.
      if (kDebugMode) {
        debugPrint('[CrashReporter] disabled — Firebase init failed: $error');
        debugPrintStack(stackTrace: stack);
      }
    }

    // Only take over error handling when we can actually report. Otherwise the
    // app keeps its default behaviour (see design rule #2).
    if (_ready) _installHandlers();
  }

  /// Route the three Dart error channels to Crashlytics. Called once, from
  /// [init], only when [_ready].
  static void _installHandlers() {
    // 1. Synchronous Flutter framework errors (build/layout/paint) → fatal.
    final FlutterExceptionHandler? priorOnError = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails details) {
      priorOnError?.call(details); // keep the console dump
      _guard(() {
        _fire(FirebaseCrashlytics.instance
            .setCustomKey('crash_type', _classify(details.exception, details.stack)));
        _fire(FirebaseCrashlytics.instance.recordFlutterFatalError(details));
      });
    };

    // 2. Uncaught ASYNC errors outside the framework (futures, callbacks,
    //    stream handlers) → fatal. Returning true marks them handled so the
    //    engine does not additionally abort.
    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      recordFatal(error, stack);
      // Collection is off in debug, so nothing would otherwise surface — print
      // the async error in debug so it stays visible to developers.
      if (kDebugMode) {
        FlutterError.presentError(
            FlutterErrorDetails(exception: error, stack: stack));
      }
      return true;
    };

    // 3. Errors that go uncaught on the ROOT isolate. (compute()/spawned
    //    isolates deliver to their OWN error ports, not this listener.)
    Isolate.current.addErrorListener(RawReceivePort((dynamic message) {
      final List<dynamic> pair = message as List<dynamic>;
      final Object error = (pair.first ?? 'Unknown isolate error') as Object;
      final StackTrace stack =
          StackTrace.fromString(pair.length > 1 ? '${pair.last}' : '');
      recordFatal(error, stack);
    }).sendPort);
  }

  /// Record a fatal error (a real crash) with a crash-type tag. Safe no-op when
  /// the reporter is not ready.
  static void recordFatal(Object error, StackTrace stack) {
    _guard(() {
      _fire(FirebaseCrashlytics.instance
          .setCustomKey('crash_type', _classify(error, stack)));
      _fire(FirebaseCrashlytics.instance.recordError(error, stack, fatal: true));
    });
  }

  /// Record a caught / non-fatal error you still want visibility on. [reason]
  /// MUST be non-PII (a short static description, never user data).
  static void recordNonFatal(Object error, StackTrace stack, {String? reason}) {
    _guard(() {
      _fire(FirebaseCrashlytics.instance
          .setCustomKey('crash_type', _classify(error, stack)));
      _fire(FirebaseCrashlytics.instance
          .recordError(error, stack, reason: reason, fatal: false));
    });
  }

  /// The screen the user is on ("/find", "payer/earn"). Set from the route
  /// observer so a crash report says WHERE it happened. Route name only —
  /// never PII.
  static void setScreen(String screen) {
    _guard(() {
      _fire(FirebaseCrashlytics.instance.setCustomKey('screen', screen));
      _fire(FirebaseCrashlytics.instance.log('screen → $screen'));
    });
  }

  /// Attach an OPAQUE, PII-free user id (the worker/payer UUID). NEVER a phone
  /// or name. Lets you find all crashes for one affected user.
  static void setUser(String opaqueId) {
    _guard(() =>
        _fire(FirebaseCrashlytics.instance.setUserIdentifier(opaqueId)));
  }

  /// Run a Crashlytics call block, swallowing any SYNC failure. The reporter
  /// must never throw into app code (fail-closed).
  static void _guard(void Function() body) {
    if (!_ready) return;
    try {
      body();
    } catch (_) {
      // Intentionally ignored — see design rule #1.
    }
  }

  /// Swallow the returned Future's ASYNC rejection. Without this a failing
  /// Crashlytics call becomes an uncaught async error, which our own
  /// [PlatformDispatcher.onError] would catch and re-report — an infinite loop.
  static void _fire(Future<void> op) {
    unawaited(op.catchError((Object _) {}));
  }

  /// Coarse crash-type hint for triage: does this look like OUR code, a
  /// third-party PACKAGE, the Flutter ENGINE, or a plugin/native channel?
  /// Best-effort — Crashlytics still keeps the full stack + device regardless.
  static String _classify(Object? error, StackTrace? stack) {
    if (error is MissingPluginException) return 'plugin_missing';
    if (error != null && error.runtimeType.toString() == 'PlatformException') {
      return 'platform_channel';
    }

    final String pkg = _topPackage(stack);
    if (pkg == _ownPackage && pkg.isNotEmpty) return 'app_code';
    if (pkg == 'flutter' || pkg == 'sky_engine') return 'flutter_engine';
    if (pkg.isNotEmpty) return 'package:$pkg';

    // Release-obfuscated stack with no package frame: fall back to the error
    // family. Dart `Error`s are programming bugs; `Exception`s are runtime.
    if (error is Error) return 'app_code';
    return 'runtime';
  }

  /// First `package:<name>/…` frame in the stack, or '' if none (obfuscated).
  static String _topPackage(StackTrace? stack) {
    if (stack == null) return '';
    final Match? m = RegExp(r'package:([a-zA-Z0-9_]+)/').firstMatch('$stack');
    return m?.group(1) ?? '';
  }
}

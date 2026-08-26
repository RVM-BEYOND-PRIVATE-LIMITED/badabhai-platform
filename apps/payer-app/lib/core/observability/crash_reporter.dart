import 'dart:async';
import 'dart:isolate';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart' show SchedulerBinding;
import 'package:flutter/services.dart' show MissingPluginException;

/// App-wide crash reporting, wired to **Firebase Crashlytics** (FlutterFire).
///
/// This is the ONLY thing that captures the ~95% of crashes that are Dart /
/// Flutter errors — native Crashlytics alone sees only JVM/NDK crashes, which
/// Flutter code never produces. Wire it from `main()` via [initAfterFirstFrame]
/// (NOT `await init(...)` before `runApp` — see design rule #4 / #379).
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
///    handlers go in early (#379) but only ever *add* to the default behaviour
///    until Crashlytics is actually up: while init is in flight they buffer and
///    still let Flutter print/handle the error, and if init fails they hand the
///    error straight back to the default path. On a device where init fails the
///    app keeps Flutter's default error behaviour instead of eating errors
///    invisibly. In debug, async errors are still surfaced.
/// 3. **No raw PII (BadaBhai invariant #2).** Only route names, an opaque user
///    id, and non-PII reasons/keys are ever attached. Never a phone, name,
///    address, OTP, or token. Device model / OS / RAM are auto-captured by
///    Crashlytics itself — that is safe metadata, not PII. (Do not embed PII in
///    exception *messages* either — those ride along to the report.)
/// 4. **Never on the critical path to the first frame (#379).** [init] awaits
///    native Firebase, which on a non-GMS/AOSP device can hang until the 8s
///    timeout — on every cold start. So `main()` calls [initAfterFirstFrame],
///    which defers the whole thing until after the first frame is on screen;
///    errors raised in that window are buffered and flushed once Crashlytics is
///    up, so deferring costs no crash coverage.
class CrashReporter {
  CrashReporter._();

  static bool _ready = false;
  static bool _initStarted = false;
  static String _ownPackage = '';

  /// Errors raised between [init] starting and Crashlytics being ready (#379).
  /// Bounded — a crash loop must not grow this without limit. Flushed to
  /// Crashlytics on success, dropped on failure (they already went down the
  /// default path, see design rule #2).
  static const int _maxPending = 20;
  static final List<_PendingError> _pending = <_PendingError>[];

  /// Open only while init is in flight. Once init has resolved there is nothing
  /// left to flush INTO, so a failed-init device must stop accumulating errors
  /// it will never send.
  static bool _buffering = false;

  /// Last screen/user set before Crashlytics was ready — re-applied on flush so
  /// a buffered early crash still carries its context (#379).
  static String? _pendingScreen;
  static String? _pendingUser;

  /// True once Firebase initialised and Crashlytics is accepting reports.
  static bool get isReady => _ready;

  /// True once [init] has been entered (whether or not it has finished). Lets
  /// callers/tests assert that init is NOT running before the first frame.
  static bool get initStarted => _initStarted;

  /// Defer [init] until after the first frame is rendered (#379).
  ///
  /// `init` awaits native Firebase, which on a non-GMS / AOSP device can hang
  /// until its 8s timeout. Awaiting that in `main()` before `runApp` meant the
  /// worker stared at the static native splash for up to 8 seconds on EVERY
  /// cold start — indistinguishable from a hung app. Scheduling it post-frame
  /// keeps the exact same fail-closed init while guaranteeing the first frame
  /// is never gated on Firebase.
  ///
  /// Fire-and-forget by design: [init] never throws, so there is nothing to
  /// await and no failure the caller could act on.
  static void initAfterFirstFrame({
    required String appName,
    required String ownPackage,
  }) {
    SchedulerBinding.instance.addPostFrameCallback((_) {
      unawaited(init(appName: appName, ownPackage: ownPackage));
    });
  }

  /// Initialise Firebase + install Crashlytics as the sink for every Dart error
  /// channel. Prefer [initAfterFirstFrame] from `main()`; call this directly
  /// only where a frame will never come (tests, headless entrypoints).
  ///
  /// [appName] tags every report (e.g. `worker-app`). [ownPackage] is this
  /// app's Dart package name (pubspec `name:`) — used only to classify a crash
  /// as our code vs a third-party package.
  ///
  /// Returns normally on ALL devices: on init failure OR a hung native init it
  /// sets [isReady] false, logs in debug, and returns — the caller keeps
  /// running and the first frame is never blocked. Idempotent: a second call is
  /// a no-op, so the error handlers are never double-installed.
  static Future<void> init({
    required String appName,
    required String ownPackage,
  }) async {
    if (_initStarted) return;
    _initStarted = true;
    _ownPackage = ownPackage;

    // #379 — install the Dart error handlers BEFORE awaiting Firebase. Init is
    // now deferred past the first frame, so real UI is already on screen while
    // it runs; without this, every error in that window would be invisible.
    // They buffer (and still let Flutter do its default thing) until _ready.
    _buffering = true;
    _installHandlers();

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

    _buffering = false;
    if (_ready) {
      // The root-isolate listener is only useful once we can report, and it
      // opens a port — so it goes in here rather than with the early handlers.
      _installIsolateHandler();
      _flushPending();
    } else {
      // Init failed: everything buffered already went down Flutter's default
      // path (see design rule #2), so drop it rather than hold it forever.
      _pending.clear();
      _pendingScreen = null;
      _pendingUser = null;
    }
  }

  /// Route the Dart error channels through us. Installed at the TOP of [init],
  /// i.e. before Firebase is up (#379) — until [_ready] the handlers only
  /// buffer and defer to the default behaviour, never swallow.
  static void _installHandlers() {
    // 1. Synchronous Flutter framework errors (build/layout/paint) → fatal.
    final FlutterExceptionHandler? priorOnError = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails details) {
      priorOnError?.call(details); // keep the console dump
      if (!_ready) {
        // Pre-ready: remember it. priorOnError above already did the default
        // thing, so nothing is hidden either way.
        _buffer(details.exception, details.stack ?? StackTrace.empty,
            fatal: true);
        return;
      }
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
      if (!_ready) {
        // Pre-ready / init failed: buffer for a later flush but return FALSE so
        // the engine still applies its default (print + report as unhandled).
        // Claiming "handled" here would silently eat errors on exactly the
        // devices where we have no reporting — design rule #2.
        _buffer(error, stack, fatal: true);
        return false;
      }
      recordFatal(error, stack);
      // Collection is off in debug, so nothing would otherwise surface — print
      // the async error in debug so it stays visible to developers.
      if (kDebugMode) {
        FlutterError.presentError(
            FlutterErrorDetails(exception: error, stack: stack));
      }
      return true;
    };
  }

  /// Errors that go uncaught on the ROOT isolate. (compute()/spawned isolates
  /// deliver to their OWN error ports, not this listener.)
  static void _installIsolateHandler() {
    Isolate.current.addErrorListener(RawReceivePort((dynamic message) {
      final List<dynamic> pair = message as List<dynamic>;
      final Object error = (pair.first ?? 'Unknown isolate error') as Object;
      final StackTrace stack =
          StackTrace.fromString(pair.length > 1 ? '${pair.last}' : '');
      recordFatal(error, stack);
    }).sendPort);
  }

  /// Hold an error raised before Crashlytics was ready (#379). Bounded: under a
  /// crash loop we keep the FIRST [_maxPending] — the earliest failure is the
  /// one that explains the rest.
  static void _buffer(Object error, StackTrace stack, {required bool fatal}) {
    if (!_buffering || _pending.length >= _maxPending) return;
    _pending.add(_PendingError(error, stack, fatal));
  }

  /// Replay everything captured during init, plus the screen/user context that
  /// was set while we were not ready, now that Crashlytics can accept it.
  static void _flushPending() {
    final String? screen = _pendingScreen;
    final String? user = _pendingUser;
    _pendingScreen = null;
    _pendingUser = null;
    if (screen != null) setScreen(screen);
    if (user != null) setUser(user);

    final List<_PendingError> queued = List<_PendingError>.of(_pending);
    _pending.clear();
    for (final _PendingError e in queued) {
      if (e.fatal) {
        recordFatal(e.error, e.stack);
      } else {
        recordNonFatal(e.error, e.stack);
      }
    }
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

  /// The screen the user is on ("/resume", "/chat", "payer/find"). Set from the
  /// route observer so a crash report says WHERE it happened. Route path only —
  /// never PII.
  static void setScreen(String screen) {
    // #379 — init now finishes AFTER the first screen is on screen, so the
    // route observer's first call lands while we are not ready. Remember it so
    // a buffered early crash still says WHERE it happened.
    if (!_ready) _pendingScreen = screen;
    _guard(() {
      _fire(FirebaseCrashlytics.instance.setCustomKey('screen', screen));
      _fire(FirebaseCrashlytics.instance.log('screen → $screen'));
    });
  }

  /// Attach an OPAQUE, PII-free user id (the worker/payer UUID). NEVER a phone
  /// or name. Lets you find all crashes for one affected user.
  static void setUser(String opaqueId) {
    // #379 — same race as [setScreen]: a worker can be restored from a stored
    // session before deferred init completes.
    if (!_ready) _pendingUser = opaqueId;
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

  /// Clear the one-shot init state so a test can exercise [init] /
  /// [initAfterFirstFrame] again. Test-only — the app inits exactly once.
  @visibleForTesting
  static void debugReset() {
    _ready = false;
    _initStarted = false;
    _buffering = false;
    _ownPackage = '';
    _pending.clear();
    _pendingScreen = null;
    _pendingUser = null;
  }
}

/// An error captured before Crashlytics was ready, awaiting flush (#379).
class _PendingError {
  const _PendingError(this.error, this.stack, this.fatal);

  final Object error;
  final StackTrace stack;
  final bool fatal;
}

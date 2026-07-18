import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/observability/crash_reporter.dart';

/// #379 — cold start used to `await CrashReporter.init(...)` before `runApp`,
/// so the first frame was gated on native Firebase init. On a non-GMS / AOSP
/// device that init hangs rather than errors, and the 8s timeout was paid on
/// EVERY launch: ~8s of frozen native splash. These lock in "init happens after
/// the first frame, and still fails closed".
///
/// The firebase_core channel is mocked to THROW, which is what a device without
/// Google Play Services does — the exact path the class must survive.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const MethodChannel firebaseCore =
      MethodChannel('plugins.flutter.io/firebase_core');

  late FlutterExceptionHandler? priorFlutterOnError;
  late bool Function(Object, StackTrace)? priorPlatformOnError;

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      firebaseCore,
      (MethodCall call) async =>
          throw PlatformException(code: 'no-google-play-services'),
    );
    // init() installs global error handlers; snapshot the harness's so each
    // test starts clean and flutter_test keeps reporting failures normally.
    priorFlutterOnError = FlutterError.onError;
    priorPlatformOnError = PlatformDispatcher.instance.onError;
    CrashReporter.debugReset();
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(firebaseCore, null);
    FlutterError.onError = priorFlutterOnError;
    PlatformDispatcher.instance.onError = priorPlatformOnError;
    CrashReporter.debugReset();
  });

  Future<void> initReporter(WidgetTester tester) => tester.runAsync(
        () => CrashReporter.init(
          appName: 'worker-app',
          ownPackage: 'badabhai_worker_app',
        ),
      );

  testWidgets('initAfterFirstFrame does not start init before the first frame',
      (WidgetTester tester) async {
    CrashReporter.initAfterFirstFrame(
      appName: 'worker-app',
      ownPackage: 'badabhai_worker_app',
    );

    // THE regression assertion: nothing Firebase-shaped has been entered yet,
    // so the frame below is not waiting on it. The old main() awaited init
    // before runApp, which is exactly what froze the native splash.
    expect(CrashReporter.initStarted, isFalse);

    await tester.pumpWidget(const MaterialApp(home: Text('first frame')));
    expect(find.text('first frame'), findsOneWidget);

    // ...and only once that frame is on screen does init run.
    await tester.pump();
    expect(CrashReporter.initStarted, isTrue);

    // Let the bounded native-init timeout elapse in fake time — this is the
    // non-GMS "init never returns" case, and it now costs the worker nothing
    // because the frame above is already painted.
    await tester.pump(const Duration(seconds: 9));
    expect(CrashReporter.isReady, isFalse);
  });

  testWidgets('init fails closed — returns normally with reporting off',
      (WidgetTester tester) async {
    await initReporter(tester);

    // No throw, no hang, and the app is told reporting is unavailable.
    expect(CrashReporter.isReady, isFalse);
  });

  testWidgets('init is idempotent — handlers are never double-installed',
      (WidgetTester tester) async {
    await initReporter(tester);
    final FlutterExceptionHandler? afterFirst = FlutterError.onError;

    await initReporter(tester);

    expect(FlutterError.onError, same(afterFirst));
  });

  testWidgets(
      'the early async handler does NOT swallow errors while reporting is off',
      (WidgetTester tester) async {
    await initReporter(tester);

    // Handlers go in before Firebase now (#379), so they exist even though init
    // failed. Returning false is what keeps design rule #2: on a device with no
    // reporting the engine still applies its default behaviour, instead of us
    // claiming "handled" and eating the error.
    final bool Function(Object, StackTrace)? onError =
        PlatformDispatcher.instance.onError;
    expect(onError, isNotNull);
    expect(onError!(StateError('boom'), StackTrace.current), isFalse);
  });

  testWidgets('the early Flutter handler still forwards to the prior handler',
      (WidgetTester tester) async {
    final List<Object> seen = <Object>[];
    FlutterError.onError = (FlutterErrorDetails d) => seen.add(d.exception);

    await initReporter(tester);

    FlutterError.onError!(FlutterErrorDetails(
      exception: StateError('render boom'),
      stack: StackTrace.current,
    ));

    expect(seen, hasLength(1));
    expect(seen.single, isA<StateError>());
  });

  testWidgets('setScreen/setUser before init do not throw',
      (WidgetTester tester) async {
    // The route observer and AuthSessionManager both fire while deferred init
    // is still in flight (#379) — that must be a safe no-op, not a crash.
    CrashReporter.setScreen('/chat');
    CrashReporter.setUser('opaque-worker-uuid');

    await initReporter(tester);

    expect(CrashReporter.isReady, isFalse);
  });
}

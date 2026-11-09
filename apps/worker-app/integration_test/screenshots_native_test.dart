import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/theme/app_typography.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/router.dart';

/// As-built screenshots rendered on a real Android device/emulator.
///
/// Runs without flutter_driver, so it is immune to the VM-service connection
/// hangs and the System-UI ANR dialog. Every screen is rendered into a
/// [RepaintBoundary] and written to the app's external files directory:
///
///   flutter test integration_test/screenshots_native_test.dart \
///     -d emulator-5554 --dart-define=USE_MOCKS=true
///
/// Then pull with:
///   adb pull /sdcard/Android/data/com.badabhai.workerapp/files/screenshots
void main() {
  final List<String> failures = <String>[];

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    AppTypography.configureFontLoading();
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    // Wire the real auth graph and walk the mock OTP + PIN flow, so auth-gated
    // screens render their real state instead of the "session expired" body.
    await initAuthLocator();
    final AuthSessionManager auth = locator<AuthSessionManager>();
    await auth.bootstrap();
    await auth.requestOtp('+919000000000');
    await auth.verifyOtp('+919000000000', '123456');
    await auth.setPin('1234');
    final SessionRepository session = locator<SessionRepository>();
    session.setProfile('mock-profile-0001');
    session.setResume('mock-resume-0001');
  });

  tearDown(() => locator.reset());

  testWidgets('worker app screenshots (native render)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final GlobalKey boundaryKey = GlobalKey();
    final GoRouter router = buildAppRouter();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundaryKey,
        child: MaterialApp.router(
          theme: AppTheme.light(),
          routerConfig: router,
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));

    // The integration-test build installs as com.example.badabhai_worker_app
    // on this project; try both ids, then the app-private cache. External
    // app-specific storage is pulled over adb while the test pauses at the end.
    final List<Directory> candidates = <Directory>[
      Directory('/sdcard/Android/data/com.example.badabhai_worker_app/files/screenshots'),
      Directory('/sdcard/Android/data/com.badabhai.workerapp/files/screenshots'),
      Directory('${Directory.systemTemp.path}/screenshots'),
    ];
    Directory outDir = candidates.last;
    for (final Directory candidate in candidates) {
      try {
        await candidate.create(recursive: true);
        final File probe = File('${candidate.path}/.probe');
        await probe.writeAsString('ok', flush: true);
        await probe.delete();
        outDir = candidate;
        break;
      } catch (_) {
        // Try the next location.
      }
    }
    final Directory fallback = Directory(
      '${Directory.systemTemp.path}/screenshots',
    );
    await fallback.create(recursive: true);

    final Map<String, String> routes = <String, String>{
      'worker_01_splash': '/',
      'worker_02_phone_login': '/login',
      'worker_03_otp_verify': '/otp',
      'worker_04_set_pin': '/pin/set',
      'worker_05_enter_pin': '/pin',
      'worker_06_forgot_pin': '/pin/forgot',
      'worker_07_consent': '/consent',
      'worker_08_employer_sharing': '/employer-sharing',
      'worker_09_name': '/name',
      'worker_10_resume_upload': '/resume-upload',
      'worker_12_chat': '/chat',
      'worker_13_voice': '/voice',
      'worker_16_profile_preview': '/profiling',
      'worker_17_finishing': '/finishing',
      'worker_20_trade_form': '/trade-form',
      'worker_23_tier_choice': '/trade-form/tier',
      'worker_26_building_resume': '/building',
      'worker_30_job_feed': '/jobs',
      'worker_33_job_search': '/jobs/search',
      'worker_34_inbox': '/inbox',
      'worker_36_notifications': '/alerts',
      'worker_37_applied_jobs': '/applications',
      'worker_38_profile_tab': '/profile',
      'worker_46_settings': '/profile/settings',
      'worker_47_devices': '/profile/settings/devices',
      'worker_44_invite': '/invite',
      'worker_45_feedback': '/feedback',
      'worker_48_suspended': '/suspended',
    };

    for (final MapEntry<String, String> entry in routes.entries) {
      try {
        router.go(entry.value);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 700));
        // Mock screens can overflow by a few pixels; drain those framework
        // exceptions so one layout warning cannot abort the whole capture run.
        while (tester.takeException() != null) {}

        final RenderRepaintBoundary boundary =
            boundaryKey.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final ui.Image image = await boundary.toImage(pixelRatio: 1.0);
        final ByteData? data =
            await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        if (data == null) {
          failures.add('${entry.key}: no PNG bytes');
          continue;
        }
        final List<int> bytes = data.buffer.asUint8List();
        try {
          await File('${outDir.path}/${entry.key}.png')
              .writeAsBytes(bytes, flush: true);
        } catch (_) {
          await File('${fallback.path}/${entry.key}.png')
              .writeAsBytes(bytes, flush: true);
        }
        // ignore: avoid_print
        print('CAPTURED ${entry.key} (${bytes.length} bytes)');
      } catch (error) {
        failures.add('${entry.key}: $error');
        // ignore: avoid_print
        print('FAILED ${entry.key}: $error');
      }
    }

    // ignore: avoid_print
    print('SCREENSHOT_DIR ${outDir.path}');
    // ignore: avoid_print
    print('SCREENSHOT_FALLBACK ${fallback.path}');
    // ignore: avoid_print
    print('SCREENSHOTS_READY');
    // Keep the app installed long enough to pull the files over adb; flutter
    // test uninstalls the APK (and its external files) as soon as this returns.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 180)),
    );
    expect(failures, isEmpty, reason: 'screenshots that failed: $failures');
  });
}

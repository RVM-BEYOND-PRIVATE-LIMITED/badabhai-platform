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
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/theme/app_typography.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/router.dart';

/// Auth-entry screenshots in the logged-out mock state (the main screenshot
/// run is authenticated, so the router correctly redirects these routes to the
/// shell there). Pull with:
///   adb exec-out run-as com.badabhai.workerapp tar -cf - \
///     -C code_cache screenshots-auth > shots.tar
void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    AppTypography.configureFontLoading();
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    await initAuthLocator();
    await locator<AuthSessionManager>().bootstrap();
  });

  tearDown(() => locator.reset());

  testWidgets('worker auth screenshots', (WidgetTester tester) async {
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
    await tester.pump(const Duration(milliseconds: 700));

    final Directory outDir =
        Directory('${Directory.systemTemp.path}/screenshots-auth');
    await outDir.create(recursive: true);

    final Map<String, String> routes = <String, String>{
      'worker_01_splash': '/',
      'worker_02_phone_login': '/login',
      'worker_03_otp_verify': '/otp',
      'worker_04_set_pin': '/pin/set',
      'worker_05_enter_pin': '/pin',
      'worker_06_forgot_pin': '/pin/forgot',
      'worker_07_consent': '/consent',
      'worker_08_employer_sharing': '/employer-sharing',
    };

    for (final MapEntry<String, String> entry in routes.entries) {
      try {
        router.go(entry.value);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 700));
        while (tester.takeException() != null) {}

        final RenderRepaintBoundary boundary =
            boundaryKey.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final ui.Image image = await boundary.toImage(pixelRatio: 1.0);
        final ByteData? data =
            await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        if (data == null) continue;
        await File('${outDir.path}/${entry.key}.png')
            .writeAsBytes(data.buffer.asUint8List(), flush: true);
        // ignore: avoid_print
        print('CAPTURED ${entry.key}');
      } catch (error) {
        // ignore: avoid_print
        print('FAILED ${entry.key}: $error');
      }
    }

    // ignore: avoid_print
    print('AUTH_SCREENSHOTS_READY ${outDir.path}');
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 120)),
    );
  });
}

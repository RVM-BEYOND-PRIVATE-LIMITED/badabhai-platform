import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/features/auth/presentation/login_screen.dart';
import 'package:payer_app/features/auth/presentation/signup_screen.dart';

/// Payer auth-entry screenshots (login + signup) in mock mode.
void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockPayerApiClient());
  });

  tearDown(() => locator.reset());

  testWidgets('payer auth screenshots', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final Directory outDir =
        Directory('${Directory.systemTemp.path}/screenshots-payer-auth');
    await outDir.create(recursive: true);

    Future<void> capture(GlobalKey key, String name) async {
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 800));
      while (tester.takeException() != null) {}
      final RenderRepaintBoundary boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final ui.Image image = await boundary.toImage(pixelRatio: 1.0);
      final ByteData? data =
          await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      if (data == null) return;
      await File('${outDir.path}/$name.png')
          .writeAsBytes(data.buffer.asUint8List(), flush: true);
      // ignore: avoid_print
      print('CAPTURED $name');
    }

    final GlobalKey loginKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: loginKey,
        child: BlocProvider<AppSessionCubit>.value(
          value: locator<AppSessionCubit>(),
          child: MaterialApp(
            theme: AppTheme.light(),
            debugShowCheckedModeBanner: false,
            home: const LoginScreen(),
          ),
        ),
      ),
    );
    await capture(loginKey, 'payer_01_login');

    final GlobalKey signupKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: signupKey,
        child: BlocProvider<AppSessionCubit>.value(
          value: locator<AppSessionCubit>(),
          child: MaterialApp(
            theme: AppTheme.light(),
            debugShowCheckedModeBanner: false,
            home: const SignupScreen(),
          ),
        ),
      ),
    );
    await capture(signupKey, 'payer_02_signup');

    // ignore: avoid_print
    print('PAYER_AUTH_SCREENSHOTS_READY ${outDir.path}');
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 120)),
    );
  });
}

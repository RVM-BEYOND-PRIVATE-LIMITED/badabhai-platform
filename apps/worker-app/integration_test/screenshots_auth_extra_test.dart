import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/enter_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/enter_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/phone_login_screen.dart';
import 'package:badabhai_worker_app/l10n/gen/app_localizations.dart';
import 'package:badabhai_worker_app/l10n/ui_locale.dart';

/// The two auth screens the main mock walk could not render (the real app
/// initialises the auth graph before the first frame; this test injects the
/// cubits directly).
void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    await initAuthLocator();
    await locator<AuthSessionManager>().bootstrap();
  });

  tearDown(() => locator.reset());

  testWidgets('worker auth extras', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final Directory outDir =
        Directory('${Directory.systemTemp.path}/screenshots-extra');
    await outDir.create(recursive: true);

    Future<void> shot(GlobalKey key, String name, Widget home) async {
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(theme: AppTheme.light(), localizationsDelegates: AppLocalizations.localizationsDelegates, supportedLocales: kUiSupportedLocales, home: home),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 700));
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

    final AuthSessionManager auth = locator<AuthSessionManager>();
    if (locator.isRegistered<PhoneLoginCubit>()) {
      locator.unregister<PhoneLoginCubit>();
    }
    locator.registerFactory<PhoneLoginCubit>(
      () => PhoneLoginCubit(auth, locale: 'hi'),
    );
    await shot(GlobalKey(), 'worker_02_phone_login', const PhoneLoginScreen());

    if (locator.isRegistered<EnterPinCubit>()) {
      locator.unregister<EnterPinCubit>();
    }
    locator.registerFactory<EnterPinCubit>(
      () => EnterPinCubit(auth, locale: 'hi', biometricEnabled: false),
    );
    await shot(GlobalKey(), 'worker_05_enter_pin', const EnterPinScreen());

    // ignore: avoid_print
    print('EXTRA_SCREENSHOTS_READY ${outDir.path}');
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 120)),
    );
  });
}



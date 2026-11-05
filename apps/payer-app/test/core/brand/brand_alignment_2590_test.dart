import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/theme/app_colors.dart';
import 'package:payer_app/core/theme/app_spacing.dart';
import 'package:payer_app/core/theme/app_system_ui.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/core/widgets/bb_avatar.dart';
import 'package:payer_app/core/widgets/bb_logo.dart';
import 'package:payer_app/features/auth/presentation/signup_screen.dart';
import 'package:payer_app/features/find/presentation/find_screen.dart';
import 'package:payer_app/features/home/presentation/home_screen.dart';
import 'package:payer_app/features/referral/presentation/referral_screen.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2590 (M2) — payer-app brand alignment fences: solid rounded icons only, no
/// runtime font fetch (Inter is bundled), the real logo instead of a stock
/// handshake icon, and status-bar styling per surface with the Home header
/// drawn behind the status bar.
///
/// The colour part of #2590 was withdrawn by the owner (brand kit, 2026-11-04),
/// so nothing here pins a palette value.
void main() {
  List<File> libDartFiles() => Directory('lib')
      .listSync(recursive: true)
      .whereType<File>()
      .where((File f) => f.path.endsWith('.dart'))
      .toList();

  group('icons', () {
    test('every Material icon in lib/ is from the solid rounded set', () {
      final RegExp icon = RegExp(r'\bIcons\.([a-z0-9_]+)');
      final List<String> offenders = <String>[];
      for (final File f in libDartFiles()) {
        for (final RegExpMatch m in icon.allMatches(f.readAsStringSync())) {
          final String name = m.group(1)!;
          if (!name.endsWith('_rounded')) offenders.add('${f.path}: $name');
        }
      }
      expect(offenders, isEmpty,
          reason: 'use the Icons.*_rounded (solid, rounded) variant');
    });

    test('no outlined icons remain', () {
      final RegExp outlined = RegExp(r'\bIcons\.[a-z0-9_]+_outline(d)?\b');
      final List<String> offenders = <String>[
        for (final File f in libDartFiles())
          if (outlined.hasMatch(f.readAsStringSync())) f.path,
      ];
      expect(offenders, isEmpty);
    });
  });

  group('fonts — no runtime fetch', () {
    test('Inter is declared in pubspec and every binary ships', () {
      final String pubspec = File('pubspec.yaml').readAsStringSync();
      expect(pubspec, contains('- family: Inter'));
      for (final String face in <String>[
        'Inter-Regular.ttf',
        'Inter-Medium.ttf',
        'Inter-SemiBold.ttf',
        'Inter-Bold.ttf',
      ]) {
        expect(pubspec, contains('assets/fonts/$face'));
        expect(File('assets/fonts/$face').existsSync(), isTrue, reason: face);
      }
      expect(File('assets/fonts/OFL-Inter.txt').existsSync(), isTrue);
    });

    test('lib/ never asks google_fonts for a face (config only)', () {
      final RegExp fetchCall = RegExp(r'GoogleFonts\.(?!config\b)\w+');
      final List<String> offenders = <String>[
        for (final File f in libDartFiles())
          if (fetchCall.hasMatch(f.readAsStringSync())) f.path,
      ];
      expect(offenders, isEmpty);
    });
  });

  group('logo', () {
    testWidgets('BbLogo paints at the requested size with a label',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Center(child: BbLogo.onBlue(size: 56)),
      ));
      expect(tester.getSize(find.byType(BbLogo)), const Size(56, 56));
      expect(find.bySemanticsLabel('BadaBhai'), findsOneWidget);
    });

    testWidgets('login header shows the real logo, not a handshake icon',
        (WidgetTester tester) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await GetIt.instance.reset();
      setupLocator(
        apiClient: MockPayerApiClient(),
        secureStore: InMemoryKeyValueStore(),
      );
      addTearDown(GetIt.instance.reset);

      await tester.pumpWidget(const PayerApp());
      await tester.pumpAndSettle();

      expect(find.byType(BbLogo), findsOneWidget);
      expect(find.byIcon(Icons.handshake), findsNothing);
      expect(find.byIcon(Icons.handshake_rounded), findsNothing);
      // The blue brand band runs under the status bar: light icons on it.
      expect(
        find.ancestor(
          of: find.byType(BbLogo),
          matching: find.byWidgetPredicate((Widget w) =>
              w is AnnotatedRegion<SystemUiOverlayStyle> &&
              w.value == AppSystemUi.onDark),
        ),
        findsOneWidget,
      );
    });
  });

  group('status bar per surface', () {
    const double statusBar = 24;
    const AppSession session = AppSession(
      role: PayerRole.company,
      account: PayerAccount(
        name: 'Kalyani Industries',
        plan: 'Starter',
        initials: 'KI',
      ),
    );

    setUp(() async {
      await GetIt.instance.reset();
      setupLocator(
        apiClient: MockPayerApiClient(),
        secureStore: InMemoryKeyValueStore(),
      );
    });

    tearDown(() async => GetIt.instance.reset());

    // Bounded pumps: a loading indicator never lets pumpAndSettle settle.
    Future<void> settle(WidgetTester tester) async {
      for (int i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> pumpShell(WidgetTester tester) async {
      tester.view.physicalSize = const Size(800, 1600);
      tester.view.devicePixelRatio = 1.0;
      tester.view.padding = const FakeViewPadding(top: statusBar);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: BlocProvider<AppSessionCubit>.value(
            value: locator<AppSessionCubit>(),
            child: const AppShell(session: session),
          ),
        ),
      );
      for (int i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('Home header is drawn behind the status bar with light icons',
        (WidgetTester tester) async {
      await pumpShell(tester);

      // No top inset above Home: its blue header starts at the very top…
      expect(tester.getTopLeft(find.byType(HomeScreen)).dy, 0);
      // …and pads its own content below the status bar.
      expect(tester.getTopLeft(find.byType(BbAvatar)).dy,
          greaterThanOrEqualTo(statusBar));
      expect(
        find.ancestor(
          of: find.byType(BbAvatar),
          matching: find.byWidgetPredicate((Widget w) =>
              w is AnnotatedRegion<SystemUiOverlayStyle> &&
              w.value == AppSystemUi.onDark),
        ),
        findsOneWidget,
      );
    });

    testWidgets(
        'wider than appMax: the status-bar strip under light icons is blue '
        'across the full width', (WidgetTester tester) async {
      await pumpShell(tester);

      final double width = tester.view.physicalSize.width;
      expect(width, greaterThan(AppSpacing.appMax));
      final Finder strip = find.byKey(AppShell.statusBarStripKey);
      expect(strip, findsOneWidget);
      expect(tester.widget<ColoredBox>(strip).color, AppColors.blue);
      final Rect rect = tester.getRect(strip);
      expect(rect.left, 0);
      expect(rect.right, width);
      expect(rect.top, 0);
      expect(rect.height, statusBar);
    });

    testWidgets('other tabs keep the top inset on the light canvas',
        (WidgetTester tester) async {
      await pumpShell(tester);
      await tester.tap(find.text('Find'));
      for (int i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(tester.getTopLeft(find.byType(FindScreen)).dy, statusBar);
      expect(find.byKey(AppShell.statusBarStripKey), findsNothing);
      expect(
        find.ancestor(
          of: find.byType(FindScreen),
          matching: find.byWidgetPredicate((Widget w) =>
              w is AnnotatedRegion<SystemUiOverlayStyle> &&
              w.value == AppSystemUi.onLight),
        ),
        findsOneWidget,
      );
    });

    // The real PayerApp, so its app-wide fallback region is in the tree.
    Future<void> pumpApp(WidgetTester tester) async {
      tester.view.physicalSize = const Size(800, 1600);
      tester.view.devicePixelRatio = 1.0;
      tester.view.padding = const FakeViewPadding(top: statusBar);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(const PayerApp());
      await settle(tester);
    }

    Brightness? statusBarIcons() =>
        SystemChrome.latestStyle?.statusBarIconBrightness;

    testWidgets(
        'a pushed light page gets dark icons, not the blue header it was '
        'opened from (Home → Refer & earn)', (WidgetTester tester) async {
      locator<AppSessionCubit>().signIn(PayerRole.agency);
      await pumpApp(tester);
      expect(find.byType(HomeScreen), findsOneWidget);
      expect(statusBarIcons(), Brightness.light);

      await tester.tap(find.text('Refer & earn'));
      await settle(tester);

      expect(find.byType(ReferralScreen), findsOneWidget);
      expect(statusBarIcons(), Brightness.dark);
    });

    testWidgets('Login → Sign up keeps light icons on the blue sign-up bar',
        (WidgetTester tester) async {
      await pumpApp(tester);
      expect(statusBarIcons(), Brightness.light);

      await tester.tap(find.byKey(const Key('signup_open')));
      await settle(tester);

      expect(find.byType(SignupScreen), findsOneWidget);
      expect(statusBarIcons(), Brightness.light);
    });

    test('app bars ask for dark status-bar icons', () {
      expect(AppTheme.light().appBarTheme.systemOverlayStyle,
          AppSystemUi.onLight);
    });
  });
}

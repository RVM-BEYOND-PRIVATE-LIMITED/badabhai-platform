import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:badabhai_worker_app/features/splash/presentation/splash_screen.dart';

/// Splash is DI-free, so it pumps without the service locator. We wrap it in a
/// minimal GoRouter (a `/login` stub) so the "Get started" CTA's `context.go`
/// resolves and we can assert the route it lands on.
Widget _app() {
  final GoRouter router = GoRouter(
    initialLocation: '/',
    routes: <RouteBase>[
      GoRoute(path: '/', builder: (_, __) => const SplashScreen()),
      GoRoute(
        path: '/login',
        builder: (_, __) => const Scaffold(body: Text('LOGIN STUB')),
      ),
    ],
  );
  return MaterialApp.router(routerConfig: router);
}

void main() {
  group('SplashScreen', () {
    // Onboarding kit Screen 1: the splash artwork (logo, `BADABHAI` wordmark,
    // `SAB HOJAYEGA` tagline, handshake — all inside the image) fills the
    // screen, and the "Get started" CTA is the kit's PrimaryActionButton
    // (ElevatedButton) drawn by Flutter on top of it.
    testWidgets('renders the brand promise + the CTA',
        (WidgetTester tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      final Image art = tester.widget<Image>(find.byKey(kSplashImageKey));
      expect((art.image as AssetImage).assetName, kSplashImageAsset);
      expect(art.fit, BoxFit.fill);
      expect(find.text('Get started'), findsOneWidget);
      expect(find.widgetWithText(ElevatedButton, 'Get started'),
          findsOneWidget);
      // The retired copy must not linger alongside the kit lockup.
      expect(find.text('No test. Just talk.'), findsNothing);
      expect(find.text('Your placement team for factory jobs'), findsNothing);
    });

    // The language picker is hidden until real localization ships. It wrote
    // `X-Locale` with no translated strings behind it, so it offered a choice
    // the app could not honour. Asserted here so it cannot reappear by accident
    // — the Settings 'Bhasha' row is covered by settings_screen_test.
    testWidgets('shows NO language picker', (WidgetTester tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      expect(find.text('भाषा चुनें · Choose language'), findsNothing);
      expect(find.text('हिंदी'), findsNothing);
      expect(find.text('मराठी'), findsNothing);
      expect(find.text('भोजपुरी'), findsNothing);
      expect(find.text('English'), findsNothing);
    });

    testWidgets('the "Get started" CTA routes to /login',
        (WidgetTester tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Get started'));
      await tester.pumpAndSettle();

      expect(find.text('LOGIN STUB'), findsOneWidget);
    });

    // Fits every screen (Y): on a SHORT screen the artwork covers the screen
    // and the CTA stays docked at the bottom, with nothing overflowing. A RenderFlex overflow would throw and takeException
    // would return it.
    testWidgets('fits a short screen without overflowing',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 480); // very short handset
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull,
          reason: 'the splash must scroll, never overflow, on a short screen');
      expect(find.byKey(kSplashImageKey), findsOneWidget);
      expect(find.text('Get started'), findsOneWidget);
    });
  });
}

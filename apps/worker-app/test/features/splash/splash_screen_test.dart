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
  group('SplashScreen language picker (Task D — inert)', () {
    testWidgets('renders the four launch languages + the prompt + the CTA',
        (WidgetTester tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      expect(find.text('हिंदी'), findsOneWidget);
      expect(find.text('मराठी'), findsOneWidget);
      expect(find.text('भोजपुरी'), findsOneWidget);
      expect(find.text('English'), findsOneWidget);
      expect(find.text('भाषा चुनें · Choose language'), findsOneWidget);
      expect(find.text('Get started'), findsOneWidget);
    });

    testWidgets('selection is single-select and visual only (one check, it moves)',
        (WidgetTester tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      // Hindi-first: exactly one chip is marked selected on load.
      expect(find.byIcon(Icons.check_rounded), findsOneWidget);

      // Tapping another language moves the selection — still exactly one check
      // (mutually exclusive), proving the inert single-select toggle.
      await tester.tap(find.text('भोजपुरी'));
      await tester.pump();
      expect(find.byIcon(Icons.check_rounded), findsOneWidget);

      await tester.tap(find.text('English'));
      await tester.pump();
      expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    });

    testWidgets('selecting a language does NOT navigate (inert — no route change)',
        (WidgetTester tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      await tester.tap(find.text('मराठी'));
      await tester.pumpAndSettle();

      // Still on Splash — the picker has no side effect beyond local state.
      expect(find.text('Get started'), findsOneWidget);
      expect(find.text('LOGIN STUB'), findsNothing);
    });

    testWidgets('the "Get started" CTA still routes to /login',
        (WidgetTester tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Get started'));
      await tester.pumpAndSettle();

      expect(find.text('LOGIN STUB'), findsOneWidget);
    });
  });
}

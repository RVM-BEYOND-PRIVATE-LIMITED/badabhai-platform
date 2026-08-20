// `/consent` has TWO arrivals and the route table is what tells them apart.
//
// ONBOARDING (#381): consent is the first step, no back button, accepting walks
// on into /name. RECOVERY: a screen the worker was already using — today the
// feedback report — pushed consent to unblock itself and handed over a
// [ConsentReturnIntent]; that arrival gets a way back and pops its outcome.
//
// The rule itself lives in [ConsentScreen.fromExtra] and is covered by
// consent_screen_test.dart. What THIS file covers is the one line that decides
// whether the rule ever runs: `router.dart`'s
// `builder: (_, state) => ConsentScreen.fromExtra(state.extra)`. The feedback
// suite stubs /consent and the consent suite builds its own router, so nothing
// else executes the production route. Swap that builder for a plain
// `const ConsentScreen()` and every other test in the repo still passes while
// the worker loses the way back.
//
// Drives the REAL router (`buildAppRouter`). Auth is deliberately NOT wired, so
// the auth redirect is inert (see `_maybeAuth` in router.dart) and the route
// table is the only thing in play.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/router.dart';

Future<GoRouter> _pumpApp(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final GoRouter router = buildAppRouter();
  await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
  await tester.pump();
  return router;
}

void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
  });

  tearDown(() => locator.reset());

  testWidgets('the production route reads the recovery marker — a pushed '
      'consent offers a way back', (WidgetTester tester) async {
    final GoRouter router = await _pumpApp(tester);

    router.push(Routes.consent, extra: const ConsentReturnIntent());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(ConsentScreen), findsOneWidget);
    expect(find.byIcon(Icons.arrow_back), findsOneWidget,
        reason: 'a worker pushed here mid-report must be able to decline and '
            'go back to the paragraph they were writing');
  });

  testWidgets('the ONBOARDING arrival is untouched — no back button (#381)', (
    WidgetTester tester,
  ) async {
    final GoRouter router = await _pumpApp(tester);

    router.go(Routes.consent);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(ConsentScreen), findsOneWidget);
    // Consent is a gate you pass through once, not a page to browse. This is
    // also the half that proves the marker is READ rather than the back arrow
    // simply always being there.
    expect(find.byIcon(Icons.arrow_back), findsNothing);
  });
}

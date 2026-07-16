// WA-3: back from the interview-kit DETAIL must land on the PROFILE branch.
//
// The kit routes used to live under /resume, so entering the kit from the
// Profile tab silently switched the shell to the Resume branch and every pop
// resolved there — the worker backed out of the kit onto the Resume tab. The
// kit is now NESTED under the Profile branch ('/profile/kit'), so this suite
// pins, against the REAL production router (buildAppRouter):
//   1. detail → pop → kit list, still on Profile (bar shows Profile active),
//   2. kit list → pop → the Profile tab screen itself,
//   3. a DEEP LINK to /profile/kit/detail/:tradeKey still builds the full
//      stack (no tab-index hack was used, so deep links keep working).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';
import 'package:badabhai_worker_app/features/kit/presentation/kit_detail_screen.dart';
import 'package:badabhai_worker_app/features/kit/presentation/kit_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';
import 'package:badabhai_worker_app/router.dart';

/// Shell branch order (router.dart): Jobs 0 · Resume 1 · Profile 2 · Alerts 3.
const int kProfileTabIndex = 2;

/// Advance the fake clock until [finder] matches (the mock client answers after
/// ~300ms; pumpAndSettle would hang on perpetual spinners).
Future<void> _pumpUntil(WidgetTester tester, Finder finder,
    {int maxFrames = 50}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      await tester.pump(const Duration(milliseconds: 400));
      return;
    }
  }
  expect(finder, findsWidgets,
      reason: 'timed out (${maxFrames * 100}ms) waiting for $finder');
}

/// Wires the REAL locator graph over [MockApiClient] (no auth graph → the
/// router redirect is inert) and pumps the REAL app router.
Future<GoRouter> _pumpApp(WidgetTester tester) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  setupLocator(apiClient: MockApiClient());

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final GoRouter router = buildAppRouter();
  await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
  await tester.pump();
  return router;
}

int _activeTab(WidgetTester tester) =>
    tester.widget<BbBottomNav>(find.byType(BbBottomNav)).currentIndex;

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
      'Profile → kit → detail, then BACK: detail pops to the kit list on the '
      'PROFILE branch, and the kit list pops to the Profile tab', (
    WidgetTester tester,
  ) async {
    final GoRouter router = await _pumpApp(tester);

    // Land on the Profile tab (mock summary loads → the kit shortcut row).
    router.go(Routes.profile);
    await _pumpUntil(tester, find.text('Interview kit'));
    expect(_activeTab(tester), kProfileTabIndex);

    // Open the kit — the Profile tab must STAY active (no branch switch).
    await tester.tap(find.text('Interview kit'));
    await _pumpUntil(tester, find.text('CNC Operator')); // mock kit row
    expect(find.byType(KitScreen), findsOneWidget);
    expect(_activeTab(tester), kProfileTabIndex);

    // Open a kit detail (full-screen on the root navigator, no bar).
    await tester.tap(find.text('CNC Operator'));
    await _pumpUntil(tester, find.text('Aam sawaal')); // detail section header
    expect(find.byType(KitDetailScreen), findsOneWidget);

    // BACK from the detail → the kit list, still on the Profile branch. This
    // was the WA-3 defect: it used to resolve to the RESUME branch.
    router.pop();
    await _pumpUntil(tester, find.byType(KitScreen));
    expect(find.byType(KitDetailScreen), findsNothing);
    expect(_activeTab(tester), kProfileTabIndex);

    // BACK from the kit list → the Profile tab screen itself.
    router.pop();
    await _pumpUntil(tester, find.byType(ProfileTabScreen));
    expect(find.byType(KitScreen), findsNothing);
    expect(_activeTab(tester), kProfileTabIndex);
  });

  testWidgets(
      'deep link to /profile/kit/detail/:tradeKey still works and pops into '
      'the Profile branch kit list', (WidgetTester tester) async {
    final GoRouter router = await _pumpApp(tester);

    router.go('${Routes.kitDetail}/cnc_operator');
    await _pumpUntil(tester, find.text('Aam sawaal'));
    expect(find.byType(KitDetailScreen), findsOneWidget);

    // The deep link built the full nested stack: popping resolves to the kit
    // list with the bar showing Profile active — not to a stray branch.
    router.pop();
    await _pumpUntil(tester, find.byType(KitScreen));
    expect(_activeTab(tester), kProfileTabIndex);
  });
}

// "Mere resume" (#1687) must OPEN — and every `Routes` constant must resolve.
//
// #1774 moved `Routes.resumeHistory` ('/profile/resumes') into the Profile
// branch, but declared it INSIDE `/profile`'s own `routes:` list with its
// absolute path. go_router matches a sub-route against what is LEFT after its
// parent (`resumes`), which `/profile/resumes` can never match — and 14.x
// accepts that tree without an assert. So the build was green and every tap on
// the Profile tab's "Mere resume" row landed on go_router's error page:
// "GoException: no routes for location: /profile/resumes".
//
// Nothing drove the real router to that path, which is the gap these tests
// close. They use the REAL app router (`buildAppRouter`) with auth NOT wired,
// which makes the auth redirect inert (see `_maybeAuth` in router.dart), so the
// production route table is what is under test — not a stand-in harness.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_history_screen.dart';
import 'package:badabhai_worker_app/router.dart';

/// Shell branch order (router.dart): Jobs 0 · Resume 1 · Bada Bhai 2 · Profile 3.
const int kProfileTabIndex = 3;
const int kChatTabIndex = 2;

/// Every absolute location `lib/router.dart` declares as a `Routes` constant.
///
/// READ FROM THE SOURCE rather than hand-listed, so a constant added tomorrow
/// is covered without anyone remembering to add it here — the same reasoning
/// as `apps/api`'s screen-template contract test, which reads this file too.
/// Only values starting with '/' are locations; `\s*` spans the formatter's
/// wrap onto the next line (`name`, `resume`, `kitDetail`, `appliedJobs`).
List<String> _declaredLocations() {
  final String source = File('lib/router.dart').readAsStringSync();
  return RegExp(r"static const String \w+\s*=\s*'(/[^']*)'")
      .allMatches(source)
      .map((RegExpMatch m) => m[1]!)
      .toList(growable: false);
}

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
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
  });
  tearDown(() async => locator.reset());

  testWidgets(
      'Profile → "Mere resume" opens the résumé list inside the Profile branch '
      '(bar stays, Profile active), and BACK returns to the Profile tab', (
    WidgetTester tester,
  ) async {
    final GoRouter router = await _pumpApp(tester);

    router.go(Routes.profile);
    await _pumpUntil(tester, find.text('Mere resume'));
    expect(_activeTab(tester), kProfileTabIndex);

    // The worker's own tap — the exact path that showed the error page.
    await tester.ensureVisible(find.text('Mere resume'));
    await tester.pump();
    await tester.tap(find.text('Mere resume'));
    await _pumpUntil(tester, find.byType(ResumeHistoryScreen));

    expect(tester.takeException(), isNull);
    expect(find.textContaining('no routes for location'), findsNothing,
        reason: '"Mere resume" must never land on the router error page');
    expect(find.byType(ResumeHistoryScreen), findsOneWidget);
    expect(find.byType(BbBottomNav), findsOneWidget,
        reason: 'the résumé list is a place in the Profile tab — the bar stays');
    expect(_activeTab(tester), kProfileTabIndex);

    // BACK → the Profile tab screen itself, still on the Profile branch.
    router.pop();
    await _pumpUntil(tester, find.byType(ProfileTabScreen));
    expect(find.byType(ResumeHistoryScreen), findsNothing);
    expect(_activeTab(tester), kProfileTabIndex);
  });

  testWidgets(
      'the /profile/resumes PATH resolves on its own onto the Profile branch',
      (WidgetTester tester) async {
    final GoRouter router = await _pumpApp(tester);

    // Resolution only. A `go` here builds a one-page branch stack (the route
    // is a SIBLING of /profile, not nested), so there is no back target —
    // latent while every caller pushes, and not asserted as if it were one.
    router.go(Routes.resumeHistory);
    await _pumpUntil(tester, find.byType(ResumeHistoryScreen));

    expect(tester.takeException(), isNull);
    expect(find.byType(ResumeHistoryScreen), findsOneWidget);
    expect(_activeTab(tester), kProfileTabIndex);
  });

  testWidgets(
      'every Routes constant resolves in the real route table — a constant '
      'with no reachable GoRoute is a button that opens the error page', (
    WidgetTester tester,
  ) async {
    final GoRouter router = buildAppRouter();
    addTearDown(router.dispose);

    final List<String> declared = _declaredLocations();
    // The sanity check that keeps the loop below from passing vacuously over an
    // empty list if the declaration style ever changes.
    expect(declared.length, greaterThan(20));
    expect(declared, contains(Routes.resumeHistory));

    bool resolves(String location) =>
        !router.configuration.findMatch(Uri.parse(location)).isError;

    // A constant resolves EXACTLY, or — for the prefixes that take an id
    // (`/jobs/detail` + '/<jobId>', `/profile/kit/detail` + '/<tradeKey>') —
    // with one segment appended. Same rule as the server's contract test.
    final List<String> unresolvable = declared
        .where((String location) =>
            !resolves(location) &&
            !resolves('${location == '/' ? '' : location}/probe-segment'))
        .toList();
    expect(unresolvable, isEmpty,
        reason: 'these Routes constants match no GoRoute — navigating to one '
            'shows "no routes for location" in a release build');

    expect(resolves(Routes.inboxThreadOf('probe-thread')), isTrue);
  });

  testWidgets(
      '"+ Banayein" SWITCHES to the Bada Bhai tab — it does not stack a second '
      'chat on the Profile branch (#1783)', (WidgetTester tester) async {
    // `/bada-bhai` is the root of the chat branch, and "Mere resume" lives in
    // the PROFILE branch. A `push` from there merged into the profile branch's
    // navigator: a SECOND ChatProfilingScreen landed on the profile stack, the
    // bar stayed on Profile, and — `ChatBloc` being a registerFactory — a whole
    // separate chat started beside the real tab's. The worker then tapped Bada
    // Bhai and found a different conversation from the one they had just been
    // typing in.
    final GoRouter router = await _pumpApp(tester);

    router.go(Routes.resumeHistory);
    await _pumpUntil(tester, find.byType(ResumeHistoryScreen));
    expect(_activeTab(tester), kProfileTabIndex);

    await tester.ensureVisible(find.text(kResumeQuickActionCta));
    await tester.pump();
    await tester.tap(find.text(kResumeQuickActionCta));
    await _pumpUntil(tester, find.byType(ChatProfilingScreen));

    expect(tester.takeException(), isNull);
    // THE TAB, not a push: the bar moves to Bada Bhai.
    expect(_activeTab(tester), kChatTabIndex,
        reason: '"+ Banayein" must land on the Bada Bhai TAB');
    // ONE chat in the tree. Two means the branch-root push re-created it on the
    // profile stack, which is the duplicate-bloc bug.
    expect(find.byType(ChatProfilingScreen, skipOffstage: false),
        findsOneWidget);
    // And "Mere resume" is no longer what is on screen.
    expect(find.byType(ResumeHistoryScreen), findsNothing);
  });
}

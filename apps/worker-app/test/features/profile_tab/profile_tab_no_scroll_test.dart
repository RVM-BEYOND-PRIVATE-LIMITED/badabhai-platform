import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/cubit/profile_tab_cubit.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

/// ── `issue3.jpeg`: the Profile tab needed scrolling to reach its options ──
///
/// The six shortcuts were full-width rows. They are now a two-column grid of
/// tiles — same options, same lines, same destinations — so the tab fits one
/// screen on an ordinary phone.
void main() {
  const List<String> shortcuts = <String>[
    'Interview kit',
    'Mere resume',
    'Mera kaam',
    'Applied jobs',
    'Sandesh',
    'Dost ko invite karein',
  ];

  // The worker in the screenshot: a confirmed profile with a trade and city.
  const ProfileSummary worker = ProfileSummary(
    tradeLabel: 'CNC Turner/Operator',
    city: 'Hathoj',
    strengthSignals: 9,
    strengthMax: 9,
  );

  Future<void> pump(WidgetTester tester, Size size) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    final MockProfileSummaryRepository repo = MockProfileSummaryRepository();
    when(() => repo.summary(includeDisplayExtras: true))
        .thenAnswer((_) async => worker);
    locator.registerFactory<ProfileTabCubit>(() => ProfileTabCubit(repo));
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
    addTearDown(locator.reset);
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const ProfileTabScreen()),
    );
    await tester.pump();
    await tester.pump();
    await tester.pump();
  }

  testWidgets('every option is still there — nothing removed',
      (WidgetTester tester) async {
    await pump(tester, const Size(360, 700));
    for (final String s in shortcuts) {
      expect(find.text(s), findsOneWidget, reason: s);
    }
    expect(find.text('Logout'), findsOneWidget);
  });

  testWidgets('on an ordinary phone the tab fits ONE screen: nothing to scroll',
      (WidgetTester tester) async {
    // 360 x 700 dp: what a 360x800 phone leaves this screen above the bottom
    // navigation and status bar (measured off issue3.jpeg, with margin).
    await pump(tester, const Size(360, 700));

    final ScrollableState scroll =
        tester.state<ScrollableState>(find.byType(Scrollable).first);
    expect(scroll.position.maxScrollExtent, 0,
        reason: 'issue3.jpeg: the options had to be scrolled to');
    // The last option and Logout are on screen without moving anything.
    expect(tester.getBottomLeft(find.text('Logout')).dy, lessThan(700));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a smaller screen still never overflows (it may scroll there)',
      (WidgetTester tester) async {
    await pump(tester, const Size(320, 480));
    for (final String s in shortcuts) {
      expect(find.text(s), findsOneWidget, reason: s);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('each tile is one labelled button for TalkBack',
      (WidgetTester tester) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    await pump(tester, const Size(360, 700));
    expect(
      find.bySemanticsLabel(RegExp(r'^Mere resume\. Purane resume')),
      findsOneWidget,
    );
    handle.dispose();
  });
}

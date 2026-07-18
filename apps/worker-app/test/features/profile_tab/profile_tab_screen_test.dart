// WA-4: the Profile-strength card renders the backend's raw signal COUNT
// honestly. The backend `strength` is an integer count (countFields recomputed
// on read) with NO denominator on the wire; the card used to render
// `count * 100 %` (a 7-signal profile read "700%") over a bar fed the raw
// count, plus a "photo → 100%" line no backend field backs. Now: "N signals"
// with actionable copy, and a real N/max meter ONLY when the backend ships
// `strength_max`. No percent is ever fabricated.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/core/widgets/bb_progress_bar.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/cubit/profile_tab_cubit.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

Future<void> _pump(WidgetTester tester, ProfileSummary summary) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final MockProfileSummaryRepository repo = MockProfileSummaryRepository();
  when(() => repo.summary()).thenAnswer((_) async => summary);
  locator.registerFactory<ProfileTabCubit>(() => ProfileTabCubit(repo));
  // The screen refetches on tab focus (T4) and resolves this from the locator.
  locator.registerLazySingleton<TabFocus>(() => TabFocus());

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const ProfileTabScreen()));
  await tester.pump(); // first frame: loading
  await tester.pump(); // summary future resolves → ready
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
      '0-state is actionable, not broken-looking: "0 cheezein" + a concrete '
      'next step, no bar, no percent', (WidgetTester tester) async {
    await _pump(
        tester, const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 0));

    expect(find.text('Profile strength'), findsOneWidget);
    expect(find.text('0 cheezein'), findsOneWidget);
    expect(
      find.text(
          'Abhi profile khaali hai — chat mein apne skills aur experience batayein.'),
      findsOneWidget,
    );
    // No denominator on the wire → no bar and no fabricated percent.
    expect(find.byType(BbProgressBar), findsNothing);
    expect(find.textContaining('%'), findsNothing);
  });

  testWidgets(
      'N-state renders the honest COUNT in DS voice (a 7-signal profile is '
      '"7 cheezein", never "700%" and never dev vocabulary)', (
    WidgetTester tester,
  ) async {
    await _pump(tester,
        const ProfileSummary(tradeLabel: 'CNC Operator', strengthSignals: 7));

    expect(find.text('7 cheezein'), findsOneWidget);
    expect(
      find.text(
          'Profile mein 7 cheezein complete — chat mein aur jankari denge to aur strong hogi.'),
      findsOneWidget,
    );
    // The pre-fix rendering (count * 100 %) must never come back, and "signals"
    // is dev vocabulary — it stays out of the UI (L-2).
    expect(find.textContaining('%'), findsNothing);
    expect(find.textContaining('signals'), findsNothing);
    expect(find.byType(BbProgressBar), findsNothing);
  });

  testWidgets(
      'a REAL backend denominator (strength_max) lights up the N/max meter',
      (WidgetTester tester) async {
    await _pump(
      tester,
      const ProfileSummary(
          tradeLabel: 'CNC Operator', strengthSignals: 6, strengthMax: 12),
    );

    expect(find.text('6/12'), findsOneWidget);
    expect(find.byType(BbProgressBar), findsOneWidget);
  });

  testWidgets(
      'Skills aur anubhav section renders experience + skill/machine chips',
      (WidgetTester tester) async {
    await _pump(
      tester,
      const ProfileSummary(
        tradeLabel: 'VMC Operator',
        strengthSignals: 9,
        skills: <String>['CNC operating', 'GD&T'],
        machines: <String>['VMC'],
        experienceYears: 4,
      ),
    );

    expect(find.text('Skills aur anubhav'), findsOneWidget);
    expect(find.text('Anubhav: 4 saal'), findsOneWidget);
    // Every skill + machine renders as a DS chip.
    expect(find.widgetWithText(BbChip, 'CNC operating'), findsOneWidget);
    expect(find.widgetWithText(BbChip, 'GD&T'), findsOneWidget);
    expect(find.widgetWithText(BbChip, 'VMC'), findsOneWidget);
    expect(find.byType(BbChip), findsNWidgets(3));
  });

  testWidgets('Skills section shows an honest empty state when nothing shared yet',
      (WidgetTester tester) async {
    await _pump(
        tester, const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 0));

    expect(find.text('Skills aur anubhav'), findsOneWidget);
    expect(
      find.text('Abhi kuch nahi — chat mein apne skills aur experience batayein.'),
      findsOneWidget,
    );
    expect(find.byType(BbChip), findsNothing);
  });
}

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
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
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
      '0-state is actionable, not broken-looking: "0 signals" + a concrete '
      'next step, no bar, no percent', (WidgetTester tester) async {
    await _pump(
        tester, const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 0));

    expect(find.text('Profile strength'), findsOneWidget);
    expect(find.text('0 signals'), findsOneWidget);
    expect(
      find.text(
          'Abhi koi signal nahi — chat mein apne skills aur experience batayein.'),
      findsOneWidget,
    );
    // No denominator on the wire → no bar and no fabricated percent.
    expect(find.byType(BbProgressBar), findsNothing);
    expect(find.textContaining('%'), findsNothing);
  });

  testWidgets(
      'N-state renders the honest COUNT (a 7-signal profile is "7 signals", '
      'never "700%")', (WidgetTester tester) async {
    await _pump(tester,
        const ProfileSummary(tradeLabel: 'CNC Operator', strengthSignals: 7));

    expect(find.text('7 signals'), findsOneWidget);
    // The pre-fix rendering (count * 100 %) must never come back.
    expect(find.textContaining('%'), findsNothing);
    expect(find.byType(BbProgressBar), findsNothing);
    // The old fabricated photo/100% promise is gone with it.
    expect(find.textContaining('100%'), findsNothing);
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
}

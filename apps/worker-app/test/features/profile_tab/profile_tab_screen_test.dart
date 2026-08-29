// #1322: the Profile-strength CONSUMER on the Profile tab. The tab no longer
// renders the raw signal count as a card ("N cheezein" / "N/max" was a grade the
// spec §9.2 forbids); it now renders the ProfileStrengthCard nudge — three bands,
// at most ONE humanized prompt, and silence at Strong. These tests assert the
// nudge integrates on the tab; the band/one-nudge/never-a-grade rules themselves
// live in widgets/profile_strength_card_test.dart.
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
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
import 'package:badabhai_worker_app/features/profile_tab/presentation/widgets/profile_strength_card.dart';

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
    MaterialApp(theme: AppTheme.light(), home: const ProfileTabScreen()),
  );
  await tester.pump(); // first frame: loading
  await tester.pump(); // summary future resolves → ready
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
    'a WEAK profile shows exactly one humanized nudge for the largest missing '
    'weight (missing_fields.first), never a number and never a raw slug',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Fitter',
          strengthSignals: 1,
          strengthMax: 9,
          // Ordered largest-weight-first by the server; only `.first` is shown.
          missingFields: <String>['role', 'skills', 'photo'],
        ),
      );

      expect(find.text(kProfileStrengthWeakTitle), findsOneWidget);
      expect(find.text('Sabse zaroori: apna kaam / role jodein.'), findsOneWidget);
      // Only ONE nudge: the lower-weight missing slots are not surfaced.
      expect(find.textContaining('apni skills'), findsNothing);
      expect(find.textContaining('apni photo'), findsNothing);
      // Never a grade: no "N/9" fraction and no percent anywhere on screen.
      expect(find.textContaining('/9'), findsNothing);
      expect(find.textContaining('%'), findsNothing);
    },
  );

  testWidgets(
    'a FAIR profile shows the single highest-value item, framed as one more thing',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'CNC Operator',
          strengthSignals: 5,
          strengthMax: 9,
          missingFields: <String>['salary', 'photo'],
        ),
      );

      expect(find.text(kProfileStrengthFairTitle), findsOneWidget);
      expect(find.text('Ek aur cheez: salary ki ummeed jodein.'), findsOneWidget);
      expect(find.text(kProfileStrengthWeakTitle), findsNothing);
    },
  );

  testWidgets(
    'a STRONG profile is silent — the strength card collapses to nothing even '
    'when a low-weight field is still missing',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'VMC Operator',
          strengthSignals: 8,
          strengthMax: 9,
          missingFields: <String>['photo'],
        ),
      );

      // No nudge is shown at Strong — the card collapses to nothing — while the
      // rest of the profile still renders below it.
      expect(find.text(kProfileStrengthWeakTitle), findsNothing);
      expect(find.text(kProfileStrengthFairTitle), findsNothing);
      expect(find.textContaining('apni photo'), findsNothing);
      expect(find.text('Skills aur anubhav'), findsOneWidget);
    },
  );

  testWidgets(
    'Skills aur anubhav section renders experience + skills/machines as plain text',
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
      // Skills and machines render as plain text (label bold, values normal weight, comma-separated).
      expect(
        find.textContaining('Skills: CNC operating, GD&T'),
        findsOneWidget,
      );
      expect(find.textContaining('Machines: VMC'), findsOneWidget);
      // No BbChip widgets used anymore.
      expect(find.byType(BbChip), findsNothing);
    },
  );

  testWidgets(
    'Skills section shows an honest empty state when nothing shared yet',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 0),
      );

      expect(find.text('Skills aur anubhav'), findsOneWidget);
      expect(
        find.text(
          'Abhi kuch nahi — chat mein apne skills aur experience batayein.',
        ),
        findsOneWidget,
      );
      // No chips or structured rows when empty.
      expect(find.byType(BbChip), findsNothing);
    },
  );

  testWidgets(
    'the TEST-ONLY delete button is compiled out of a normal build: with '
    'kEnableTestDelete false (the default), only Logout renders — no '
    '"Delete account (test)"',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 3),
      );

      // Logout is always present, proving the profile rendered to its footer.
      expect(find.text('Logout'), findsOneWidget);
      // The flag is a compile-time const false in tests, so the button subtree
      // is never built.
      expect(find.text('Delete account (test)'), findsNothing);
    },
  );
}

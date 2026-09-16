// #1322: the Profile-strength CONSUMER on the Profile tab. The tab no longer
// renders the raw signal count as a card ("N cheezein" / "N/max" was a grade the
// spec §9.2 forbids); it now renders the ProfileStrengthCard nudge — three bands,
// at most ONE humanized prompt, and silence at Strong. These tests assert the
// nudge integrates on the tab; the band/one-nudge/never-a-grade rules themselves
// live in widgets/profile_strength_card_test.dart.
//
// UI kit v3: skills and machines are kit CHIPS now (ruling R9 reverses the old
// "no chips, comma text" call), the identity block moved out of the blue header
// into the first card, and the worker's NAME comes from the resume fields
// (ruling R5) — optional, fail-silent, never fabricated.
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_info_chip.dart';
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
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

/// The resume-fields source the Profile tab reads the NAME from (R5). Present
/// only in the test that asserts the name — everywhere else it stays
/// unregistered, which is exactly the fail-silent path the real app takes when
/// the read is unavailable.
class _FakeResumeEditRepository implements ResumeEditRepository {
  _FakeResumeEditRepository(this.name);

  final String name;

  @override
  Future<ResumeSafeFields> load() async => ResumeSafeFields(
    displayName: name,
    showPhoto: true,
    nightShiftReady: false,
  );

  @override
  Future<bool> save(ResumeSafeFields fields) async => false;

  @override
  void onLogout() {}
}

Future<void> _pump(
  WidgetTester tester,
  ProfileSummary summary, {
  String? name,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final MockProfileSummaryRepository repo = MockProfileSummaryRepository();
  when(() => repo.summary()).thenAnswer((_) async => summary);
  locator.registerFactory<ProfileTabCubit>(() => ProfileTabCubit(repo));
  // The screen refetches on tab focus (T4) and resolves this from the locator.
  locator.registerLazySingleton<TabFocus>(() => TabFocus());
  if (name != null) {
    locator.registerSingleton<ResumeEditRepository>(
      _FakeResumeEditRepository(name),
    );
  }

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light(), home: const ProfileTabScreen()),
  );
  await tester.pump(); // first frame: loading
  await tester.pump(); // summary future resolves → ready
  await tester.pump(); // the optional name read resolves (when registered)
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
      expect(
        find.text('Sabse zaroori: apna kaam / role jodein.'),
        findsOneWidget,
      );
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
      expect(
        find.text('Ek aur cheez: salary ki ummeed jodein.'),
        findsOneWidget,
      );
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

  testWidgets('Skills aur anubhav section renders experience as a fact row and '
      'skills/machines as kit chips (R9), with a real count pill', (
    WidgetTester tester,
  ) async {
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
    // Each value is its own chip, under its own micro label.
    expect(find.byType(KitInfoChip), findsNWidgets(3));
    expect(find.text('CNC operating'), findsOneWidget);
    expect(find.text('GD&T'), findsOneWidget);
    expect(find.text('VMC'), findsOneWidget);
    expect(find.text('SKILLS'), findsOneWidget);
    expect(find.text('MACHINES'), findsOneWidget);
    // The count pill is the real total (2 skills + 1 machine), digits only —
    // never the spec mock's "Verified" claim (ruling R8).
    expect(find.text('3'), findsOneWidget);
    expect(find.textContaining('Verified'), findsNothing);
    // The comma-separated text this section used to render is gone, and
    // BbChip (chat / trade-form's chip) is still not used here.
    expect(find.textContaining('Skills: CNC operating'), findsNothing);
    expect(find.byType(BbChip), findsNothing);
  });

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
      // No chips and no count pill when there is nothing to count.
      expect(find.byType(KitInfoChip), findsNothing);
      expect(find.byType(BbChip), findsNothing);
      expect(find.text('0'), findsNothing);
    },
  );

  testWidgets(
    'the worker NAME comes from the resume fields (R5) and leads the identity '
    'card, with the trade moving to the subline',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'CNC Operator',
          city: 'Pune',
          strengthSignals: 9,
          experienceYears: 4,
        ),
        name: 'Ramesh Kumar',
      );

      expect(find.text('Ramesh Kumar'), findsOneWidget);
      // Trade · experience · city, all real values, joined once.
      expect(find.text('CNC Operator • 4 saal • Pune'), findsOneWidget);
      // The monogram is derived from the real name (never invented).
      expect(find.text('RK'), findsOneWidget);
      expect(find.text('WORKER PROFILE'), findsOneWidget);
    },
  );

  testWidgets(
    'without a name read the card leads with the TRADE — never a fabricated '
    'name, and never the generic fallback while a trade exists',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'CNC Operator',
          city: 'Pune',
          strengthSignals: 9,
        ),
      );

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.text('Aapki profile'), findsNothing);
      // The trade is the headline, so it is not repeated in the subline.
      expect(find.text('Pune'), findsOneWidget);
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

  testWidgets(
    'Logout asks first: dismissing the confirm keeps the worker signed in',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 3),
      );

      await tester.tap(find.text('Logout'));
      await tester.pumpAndSettle();

      // Copy unchanged from the dialog this replaced.
      expect(find.text('Logout karein?'), findsOneWidget);
      expect(find.text('Aap dobara login kar sakte hain.'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Logout karein?'), findsNothing);
      // Still on the profile.
      expect(find.text('Skills aur anubhav'), findsOneWidget);
    },
  );
}

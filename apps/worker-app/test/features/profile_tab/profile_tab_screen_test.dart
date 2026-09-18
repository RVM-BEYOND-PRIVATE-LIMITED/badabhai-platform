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
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_verified_badge.dart';
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
  when(() => repo.summary(includeDisplayExtras: true)).thenAnswer((_) async => summary);
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
      // rest of the profile still renders below it. The empty skills section
      // hides too (#1579); the identity card proves the profile rendered.
      expect(find.text(kProfileStrengthWeakTitle), findsNothing);
      expect(find.text(kProfileStrengthFairTitle), findsNothing);
      expect(find.textContaining('apni photo'), findsNothing);
      expect(find.text('Skills aur anubhav'), findsNothing);
      expect(find.text('VMC Operator'), findsOneWidget);
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
    'Skills section hides entirely when nothing shared yet (#1579)',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 0),
      );

      // No heading, no claim-like empty sentence, no chips, no count pill.
      expect(find.text('Skills aur anubhav'), findsNothing);
      expect(find.textContaining('Abhi kuch nahi'), findsNothing);
      expect(find.byType(KitInfoChip), findsNothing);
      expect(find.byType(BbChip), findsNothing);
      expect(find.text('0'), findsNothing);
    },
  );

  // #1524 — a chat-sourced profile is labelled so it can never be silently
  // mistaken for the form road's trade-sheet profile; form and unknown stay
  // exactly as they rendered before.
  testWidgets(
    'a CHAT-sourced profile carries the chat-road badge',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Welder',
          strengthSignals: 4,
          source: 'chat',
        ),
      );

      expect(find.text(kChatProfileSourceLabel), findsOneWidget);
    },
  );

  testWidgets(
    'a FORM-sourced (and a null-source) profile carries no chat-road badge',
    (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Welder',
          strengthSignals: 4,
          source: 'form',
        ),
      );
      expect(find.text(kChatProfileSourceLabel), findsNothing);

      await _pump(
        tester,
        const ProfileSummary(tradeLabel: 'Welder', strengthSignals: 4),
      );
      expect(find.text(kChatProfileSourceLabel), findsNothing);
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
      // Still on the profile (identity card proves it; the empty skills
      // section hides per #1579).
      expect(find.text('Fitter'), findsOneWidget);
    },
  );

  // #1576 — the chat-captured languages and work types, as labelled chips.
  group('captured languages + work types', () {
    testWidgets('renders both as chips when present', (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Fitter',
          strengthSignals: 5,
          languages: <String>['Hindi', 'English'],
          workTypes: <String>['Permanent', 'Daily wage'],
        ),
      );

      expect(find.text('Bhasha aur kaam'), findsOneWidget);
      expect(find.text('BHASHAYEIN'), findsOneWidget);
      expect(find.text('Hindi'), findsOneWidget);
      expect(find.text('English'), findsOneWidget);
      expect(find.text('KAAM KA PRAKAR'), findsOneWidget);
      expect(find.text('Permanent'), findsOneWidget);
      expect(find.text('Daily wage'), findsOneWidget);
    });

    testWidgets('hides the whole section when both are empty',
        (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 3),
      );

      expect(find.text('Bhasha aur kaam'), findsNothing);
      expect(find.text('BHASHAYEIN'), findsNothing);
      expect(find.text('KAAM KA PRAKAR'), findsNothing);
    });

    testWidgets('shows only work types when languages are absent',
        (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Fitter',
          strengthSignals: 4,
          workTypes: <String>['Contract'],
        ),
      );

      expect(find.text('Bhasha aur kaam'), findsOneWidget);
      expect(find.text('KAAM KA PRAKAR'), findsOneWidget);
      expect(find.text('BHASHAYEIN'), findsNothing);
    });
  });

  /// #1586 — the pill/seal render on SERVER ATTESTATION, never confirmation.
  group('verification badge follows attestation', () {
    testWidgets('attested worker shows pill and seal', (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Fitter',
          strengthSignals: 5,
          verified: true,
          attested: true,
        ),
      );

      expect(find.byType(BbVerifiedBadge), findsOneWidget);
      expect(find.byType(BbSeal), findsOneWidget);
    });

    testWidgets('confirmed-but-unattested worker shows neither — and no '
        '"Unverified" copy', (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Fitter',
          strengthSignals: 5,
          verified: true,
        ),
      );

      expect(find.byType(BbVerifiedBadge), findsNothing);
      expect(find.byType(BbSeal), findsNothing);
      expect(find.text('Unverified'), findsNothing);
      expect(find.text('unverified'), findsNothing);
    });
  });

  /// #1587 — the v4 work facts render as rows/chips; absence hides the card.
  group('work info card', () {
    testWidgets('renders every present v4 fact', (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Fitter',
          strengthSignals: 5,
          commuteKm: 20,
          willingToTravel: true,
          salaryPeriod: 'Din',
          availabilityStatus: 'Notice period mein',
          availableFrom: '2026-10-01',
          noticeDays: 15,
          trainings: <String>['CNC Programming · ITI Pune · 2019'],
          occupations: <SecondaryOccupation>[
            SecondaryOccupation(roleId: 'role_welder', label: 'Welder'),
          ],
        ),
      );

      expect(find.text('Kaam ki jaankari'), findsOneWidget);
      expect(find.text('Aane-jaane: 20 km tak'), findsOneWidget);
      expect(find.text('Travel kar sakte hain'), findsOneWidget);
      expect(find.text('Salary: Din ke hisaab se'), findsOneWidget);
      expect(find.text('Uplabdhata: Notice period mein'), findsOneWidget);
      expect(find.text('Kab se: 2026-10-01'), findsOneWidget);
      expect(find.text('Notice: 15 din'), findsOneWidget);
      expect(
        find.text('Training: CNC Programming · ITI Pune · 2019'),
        findsOneWidget,
      );
      expect(find.text('AUR KAAM'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget);
    });

    testWidgets('hides the card when every v4 fact is absent',
        (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(tradeLabel: 'Fitter', strengthSignals: 3),
      );

      expect(find.text('Kaam ki jaankari'), findsNothing);
    });
  });

  /// #1579 — ONE rule over every section, enforced by a single table: an
  /// empty section renders nothing (no heading, no gap, no claim-like empty
  /// sentence), unless it maps to an existing one-tap collection route, in
  /// which case exactly one compact Add entry renders in its place.
  group('empty-zone rule', () {
    testWidgets('all-empty profile: no section headings, two Add entries',
        (WidgetTester tester) async {
      await _pump(
        tester,
        const ProfileSummary(strengthSignals: 0),
      );

      // Headings without content: none may render.
      expect(find.text('Skills aur anubhav'), findsNothing);
      expect(find.text('Bhasha aur kaam'), findsNothing);
      expect(find.text('Kaam ki jaankari'), findsNothing);
      expect(find.textContaining('Abhi kuch nahi'), findsNothing);
      expect(find.text('No experience'), findsNothing);
      // The two collectable sections render exactly one Add entry each.
      expect(find.text('Bhasha aur kaam jodein'), findsOneWidget);
      expect(find.text('Kaam ki jaankari jodein'), findsOneWidget);
      // The chrome around them is untouched.
      expect(find.text('Profile edit karein'), findsOneWidget);
      expect(find.text('Logout'), findsOneWidget);
    });

    testWidgets(
        'ONE rule over every section: heading iff content, else the single '
        'compact Add entry (#1579)', (WidgetTester tester) async {
      const List<({String name, ProfileSummary filled, String heading, String? add})>
          sections = <({
        String name,
        ProfileSummary filled,
        String heading,
        String? add,
      })>[
        (
          name: 'skills',
          filled: ProfileSummary(
            strengthSignals: 0,
            skills: <String>['MIG Welding'],
          ),
          heading: 'Skills aur anubhav',
          add: null, // hides entirely — the kit is the collection path
        ),
        (
          name: 'languages',
          filled: ProfileSummary(
            strengthSignals: 0,
            languages: <String>['Hindi'],
          ),
          heading: 'Bhasha aur kaam',
          add: 'Bhasha aur kaam jodein',
        ),
        (
          name: 'work info',
          filled: ProfileSummary(strengthSignals: 0, commuteKm: 20),
          heading: 'Kaam ki jaankari',
          add: 'Kaam ki jaankari jodein',
        ),
      ];

      Future<void> freshPump(ProfileSummary summary) async {
        // pumpWidget reuses a same-shaped tree (the provider — and its cubit
        // — would survive), so flush to an empty frame first.
        await tester.pumpWidget(const SizedBox.shrink());
        await _pump(tester, summary);
      }

      for (final section in sections) {
        // Filled: the heading renders, and no Add entry stands beside it.
        await freshPump(section.filled);
        expect(find.text(section.heading), findsOneWidget,
            reason: '${section.name}: filled section must head itself');
        if (section.add != null) {
          expect(find.text(section.add!), findsNothing,
              reason: '${section.name}: filled section needs no Add entry');
        }

        // Empty: no heading, no gap-claim — the Add entry or nothing.
        await freshPump(const ProfileSummary(strengthSignals: 0));
        expect(find.text(section.heading), findsNothing,
            reason: '${section.name}: empty section must not head itself');
        if (section.add != null) {
          expect(find.text(section.add!), findsOneWidget,
              reason: '${section.name}: empty section gets one Add entry');
        }
      }
      // And never, in either shape, a sentence describing the worker.
      expect(find.text('No experience'), findsNothing);
      expect(find.textContaining('Abhi kuch nahi'), findsNothing);
    });

    testWidgets('Add entries route to Profile Edit', (WidgetTester tester) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await locator.reset();
      final MockProfileSummaryRepository repo =
          MockProfileSummaryRepository();
      when(() => repo.summary(includeDisplayExtras: true)).thenAnswer(
        (_) async => const ProfileSummary(strengthSignals: 0),
      );
      locator.registerFactory<ProfileTabCubit>(() => ProfileTabCubit(repo));
      locator.registerLazySingleton<TabFocus>(() => TabFocus());
      tester.view.physicalSize = const Size(900, 1900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(() async => locator.reset());

      final GoRouter router = GoRouter(
        initialLocation: '/profile',
        routes: <RouteBase>[
          GoRoute(
            path: '/profile',
            builder: (_, __) => const ProfileTabScreen(),
          ),
          GoRoute(
            path: '/profile/edit',
            builder: (_, __) =>
                const Scaffold(body: Text('PROFILE EDIT TARGET')),
          ),
        ],
      );
      await tester.pumpWidget(
        MaterialApp.router(
          theme: AppTheme.light(),
          routerConfig: router,
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      await tester.tap(find.text('Bhasha aur kaam jodein'));
      await tester.pumpAndSettle();
      expect(find.text('PROFILE EDIT TARGET'), findsOneWidget);
    });
  });

}

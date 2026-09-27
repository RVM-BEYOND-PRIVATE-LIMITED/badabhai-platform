import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_pill.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_draft_card.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_file_card.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_history_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_history_section.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/profiling_tier.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/router.dart' show Routes;
import 'package:go_router/go_router.dart';

class _MockResumeRepository extends Mock implements ResumeRepository {}

class _MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class _MockProfileRepository extends Mock implements ProfileRepository {}

/// The profile summary the cards read their facts from. Hand-written rather
/// than mocked so a test can also make the read FAIL, which the screen must
/// survive with fewer facts and no error.
class _FakeSummary implements ProfileSummaryRepository {
  _FakeSummary(this._summary) : _fails = false;
  _FakeSummary.failing() : _summary = null, _fails = true;

  final ProfileSummary? _summary;
  final bool _fails;

  /// What the screen asked for on its last read (#1782). Attestation is only
  /// populated in EXTRAS mode, so "did the screen ask for extras" is the
  /// difference between a real verification note and one that can never be true.
  bool? askedForExtras;

  @override
  Future<ProfileSummary> summary({bool includeDisplayExtras = false}) async {
    askedForExtras = includeDisplayExtras;
    if (_fails || _summary == null) throw const NetworkFailure();
    return _summary;
  }
}

/// #1687 — "Mere resume", the Profile tab's own list of every resume the worker
/// has made.
///
/// The list is the SERVER's window (`RESUME_HISTORY_VISIBLE_LIMIT`, ruling R4
/// "keep all, show three"): nothing is deleted, and an older entry stays
/// downloadable by its own id.
void main() {
  late _MockResumeRepository repo;

  /// Swapped per test, before `pump`.
  ProfileSummaryRepository summaryRepo = _FakeSummary(
    ProfileSummary(strengthSignals: 0),
  );

  ResumeHistoryItem item({
    required String id,
    required int day,
    ResumeSource? source = ResumeSource.chat,
    bool current = false,
  }) => ResumeHistoryItem(
    resumeId: id,
    profileId: 'p1',
    source: source,
    trigger: ResumeTrigger.profileConfirmed,
    generatedAt: DateTime.utc(2026, 9, day),
    renderStatus: 'rendered',
    renderedAt: DateTime.utc(2026, 9, day),
    isCurrent: current,
  );

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    repo = _MockResumeRepository();
    final _MockResumeEditRepository editRepo = _MockResumeEditRepository();
    when(() => editRepo.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Test',
        showPhoto: false,
        nightShiftReady: false,
      ),
    );
    when(() => repo.loadResumeDocument())
        .thenAnswer((_) async => const ResumeDocumentSnapshot());
    summaryRepo = _FakeSummary(ProfileSummary(strengthSignals: 0));
    locator.registerFactory<ResumeCubit>(
      () => ResumeCubit(repo, editRepo, _MockProfileRepository()),
    );
    locator.registerFactory<ProfileSummaryRepository>(() => summaryRepo);
  });

  tearDown(() async => locator.reset());

  Future<void> pump(WidgetTester tester, ResumeHistory history) async {
    when(() => repo.loadResumeHistory()).thenAnswer((_) async => history);
    tester.view.physicalSize = const Size(420, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const ResumeHistoryScreen()),
    );
    await tester.pump();
    await tester.pump();
  }

  testWidgets('lists EVERY resume the server returned, newest first', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(
        items: <ResumeHistoryItem>[
          item(id: 'r4', day: 20, current: true),
          item(id: 'r3', day: 18, source: ResumeSource.form),
          item(id: 'r2', day: 15, source: ResumeSource.resumeUpload),
          item(id: 'r1', day: 12),
        ],
      ),
    );

    expect(find.text(kResumeHistoryScreenTitle), findsOneWidget);
    // FOUR resumes, four cards — the app does not re-trim what the server sent.
    expect(find.text('20 Sep 2026'), findsOneWidget);
    expect(find.text('18 Sep 2026'), findsOneWidget);
    expect(find.text('15 Sep 2026'), findsOneWidget);
    expect(find.text('12 Sep 2026'), findsOneWidget);
    // Each labelled with the flow that made it, humanised — never a raw token.
    expect(find.text('Chat se bana resume'), findsNWidgets(2));
    expect(find.text('Form se bana resume'), findsOneWidget);
    expect(find.text('Resume upload se bana resume'), findsOneWidget);
    expect(find.textContaining('resume_upload'), findsNothing);
    // The uuid never reaches the screen either.
    expect(find.textContaining('r4'), findsNothing);
  });

  testWidgets('the title carries a REAL file count, and hides it at zero', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(
        items: <ResumeHistoryItem>[
          item(id: 'r2', day: 20, current: true),
          item(id: 'r1', day: 12),
        ],
      ),
    );
    expect(find.text('2 Files'), findsOneWidget);
  });

  testWidgets('an empty list shows NO count pill — never "0 Files"', (
    WidgetTester tester,
  ) async {
    await pump(tester, ResumeHistory.empty);
    expect(find.textContaining('File'), findsNothing);
  });

  testWidgets('one file reads "1 File", not "1 Files"', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(items: <ResumeHistoryItem>[item(id: 'r1', day: 12)]),
    );
    expect(find.text('1 File'), findsOneWidget);
  });

  testWidgets('the quick action and the support callout are both present', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(items: <ResumeHistoryItem>[item(id: 'r1', day: 12)]),
    );
    expect(find.text(kResumeQuickActionTitle), findsOneWidget);
    expect(find.text(kResumeQuickActionCta), findsOneWidget);
    expect(find.text(kResumeHelpTitle), findsOneWidget);
  });

  testWidgets('the quick action shows even with NO resumes — it is how a '
      'worker makes their first one', (WidgetTester tester) async {
    await pump(tester, ResumeHistory.empty);
    expect(find.text(kResumeQuickActionTitle), findsOneWidget);
    expect(find.text(kResumeHistoryEmptyTitle), findsOneWidget);
  });

  testWidgets('every card carries its OWN download and share', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(
        items: <ResumeHistoryItem>[
          item(id: 'r2', day: 20, current: true),
          item(id: 'r1', day: 12),
        ],
      ),
    );

    expect(find.text('PDF download karein'), findsNWidgets(2));
  });

  testWidgets('no history: an honest empty state, never an error', (
    WidgetTester tester,
  ) async {
    await pump(tester, ResumeHistory.empty);

    expect(find.text(kResumeHistoryEmptyTitle), findsOneWidget);
    expect(find.text(kResumeHistoryScreenTitle), findsOneWidget);
  });

  testWidgets('the screen does not repeat the section heading — its own '
      'header already says what the list is', (WidgetTester tester) async {
    await pump(
      tester,
      ResumeHistory(items: <ResumeHistoryItem>[item(id: 'r1', day: 12)]),
    );

    expect(find.text(kResumeHistoryTitle.toUpperCase()), findsNothing);
  });

  group('the current card carries the profile\'s real facts', () {
    testWidgets('trade, experience, machines and city — on the CURRENT entry '
        'only', (WidgetTester tester) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'CNC Turner & Setup',
          city: 'Pune MIDC',
          machines: <String>['Fanuc', 'Siemens'],
          experienceYears: 3.5,
          // ATTESTED, not merely `verified` (#1782): the note is a trust signal
          // and `verified` is a lifecycle flag, so only this drives it now.
          attested: true,
          strengthSignals: 0,
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[
            item(id: 'r2', day: 20, current: true),
            item(id: 'r1', day: 12),
          ],
        ),
      );

      expect(find.text('CNC Turner & Setup'), findsOneWidget);
      expect(find.text('3.5 Yrs • Fanuc & Siemens • Pune MIDC'), findsOneWidget);
      expect(find.text(kResumeFormatChip), findsOneWidget);
      expect(find.textContaining(kResumeVerifiedNote), findsOneWidget);
      // The OLDER card must not borrow the current profile's facts — it was
      // made from a profile this build cannot read.
      expect(find.text('CNC Turner & Setup'), findsOneWidget);
      expect(find.text('Chat se bana resume'), findsOneWidget);
    });

    testWidgets('a whole number of years reads "2 Yrs", not "2.0 Yrs"', (
      WidgetTester tester,
    ) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'Welder',
          experienceYears: 2,
          strengthSignals: 0,
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      expect(find.text('2 Yrs'), findsOneWidget);
    });

    testWidgets('no profile summary: the card still draws, with fewer facts', (
      WidgetTester tester,
    ) async {
      summaryRepo = _FakeSummary.failing();
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('20 Sep 2026'), findsOneWidget);
      expect(find.text('Exp:'), findsNothing);
    });
  });

  group('card layout (measured, not described)', () {
    testWidgets('the two actions sit SIDE BY SIDE on a real handset, never '
        'stacked', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      when(() => repo.loadResumeHistory()).thenAnswer(
        (_) async => ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.light(), home: const ResumeHistoryScreen()),
      );
      await tester.pump();
      await tester.pump();

      final Offset share = tester.getTopLeft(
        find.text('WhatsApp pe bhejein'),
      );
      final Offset download = tester.getTopLeft(
        find.text('PDF download karein'),
      );
      expect(
        download.dx,
        greaterThan(share.dx),
        reason: 'download must sit to the RIGHT of share',
      );
      expect(
        (download.dy - share.dy).abs(),
        lessThan(8),
        reason: 'same row, not one above the other',
      );
    });

    testWidgets('the title starts to the RIGHT of the doc icon, in line with '
        'the status pill', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'CNC Turner & Setup',
          strengthSignals: 0,
        ),
      );
      when(() => repo.loadResumeHistory()).thenAnswer(
        (_) async => ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.light(), home: const ResumeHistoryScreen()),
      );
      await tester.pump();
      await tester.pump();

      final Offset title = tester.getTopLeft(find.text('CNC Turner & Setup'));
      // The pill's BOX, not its text: the text is inset by the pill's own
      // horizontal padding, so comparing against it would measure the padding
      // rather than the column's left edge.
      final Offset pill = tester.getTopLeft(find.byType(KitPill).first);
      final Rect icon = tester.getRect(
        find.byIcon(Icons.description_outlined).first,
      );

      expect(
        title.dx,
        greaterThan(icon.right),
        reason: 'the title must clear the icon, not sit under it',
      );
      expect(
        (title.dx - pill.dx).abs(),
        lessThan(6),
        reason: 'title and pill share a left edge',
      );
      expect(
        title.dy,
        greaterThan(pill.dy),
        reason: 'the title sits under the pills, inside the same column',
      );
    });
  });

  group('per-résumé facts from the row itself (backend #1714)', () {
    ResumeHistoryItem rich({required bool current}) => ResumeHistoryItem(
      resumeId: 'r-old',
      profileId: 'p-old',
      source: ResumeSource.form,
      generatedAt: DateTime.utc(2026, 8, 12),
      renderStatus: 'rendered',
      renderedAt: DateTime.utc(2026, 8, 12),
      isCurrent: current,
      tradeLabel: 'VMC Milling Technician',
      experienceYears: 2,
      machines: <String>['3-Axis', '4-Axis'],
      city: 'Manesar / Gurugram',
      pageCount: 1,
      displayRef: '#BB-8492',
    );

    testWidgets('an OLDER row renders its own trade, exp, machines, city, '
        'page count and short id', (WidgetTester tester) async {
      // The current profile is a DIFFERENT trade — the old card must not
      // borrow any of it.
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'CNC Turner & Setup',
          city: 'Pune MIDC',
          experienceYears: 3.5,
          strengthSignals: 0,
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[
            item(id: 'r-new', day: 20, current: true),
            rich(current: false),
          ],
        ),
      );

      expect(find.text('VMC Milling Technician'), findsOneWidget);
      expect(find.text('2 Yrs • 3-Axis & 4-Axis • Manesar / Gurugram'),
          findsOneWidget);
      expect(find.textContaining('1 Page'), findsOneWidget);
      expect(find.text('ID: #BB-8492'), findsOneWidget);
      // And it did NOT take the current profile's city.
      expect(find.textContaining('Pune MIDC • '), findsNothing);
    });

    testWidgets('the row WINS over the profile summary on the current card', (
      WidgetTester tester,
    ) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(tradeLabel: 'Something Else', strengthSignals: 0),
      );
      await pump(
        tester,
        ResumeHistory(items: <ResumeHistoryItem>[rich(current: true)]),
      );

      expect(find.text('VMC Milling Technician'), findsOneWidget);
      expect(find.text('Something Else'), findsNothing);
    });

    testWidgets('"1 Page" and "2 Pages" — never "1 Pages"', (
      WidgetTester tester,
    ) async {
      await pump(
        tester,
        ResumeHistory(items: <ResumeHistoryItem>[rich(current: false)]),
      );
      expect(find.textContaining('1 Page'), findsOneWidget);
      expect(find.textContaining('1 Pages'), findsNothing);
    });

    testWidgets('no page count from the server: the slot is omitted, never '
        'guessed', (WidgetTester tester) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'Welder',
          experienceYears: 2,
          strengthSignals: 0,
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      expect(find.textContaining('Page'), findsNothing);
      expect(find.text(kResumeFormatChip), findsOneWidget);
    });

    testWidgets('a raw uuid is NEVER shown as the id', (
      WidgetTester tester,
    ) async {
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[
            item(id: 'e3b0c442-98fc-1c14-9afb-4c8996fb9242', day: 20),
          ],
        ),
      );
      expect(find.textContaining('e3b0c442'), findsNothing);
      expect(find.textContaining('ID:'), findsNothing);
    });
  });

  group('the unfinished-profile card', () {
    testWidgets('shows the SERVER\'s percentage and its missing fields', (
      WidgetTester tester,
    ) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'General Machinist',
          strengthSignals: 6,
          strengthMax: 10,
          missingFields: <String>['salary', 'experience'],
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );

      expect(find.textContaining(kResumeDraftPill), findsOneWidget);
      expect(find.text('60% complete'), findsOneWidget);
      expect(find.text(kResumeDraftCta), findsOneWidget);
      // The missing fields are HUMANISED at the display edge — the worker
      // reads 'salary ki ummeed', never the raw `salary` / `experience` slugs.
      expect(
        find.textContaining('Sirf salary ki ummeed aur'),
        findsOneWidget,
      );
    });

    testWidgets('nothing missing: no draft card at all', (
      WidgetTester tester,
    ) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(tradeLabel: 'Welder', strengthSignals: 10),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      expect(find.textContaining(kResumeDraftPill), findsNothing);
    });

    testWidgets('no denominator: no progress bar invented', (
      WidgetTester tester,
    ) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'Welder',
          strengthSignals: 3,
          missingFields: <String>['salary'],
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      expect(find.textContaining(kResumeDraftPill), findsOneWidget);
      expect(find.textContaining('% complete'), findsNothing);
      expect(find.byType(LinearProgressIndicator), findsNothing);
    });
  });

  testWidgets('it reads the history and never generates a resume', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(items: <ResumeHistoryItem>[item(id: 'r1', day: 12)]),
    );

    verify(() => repo.loadResumeHistory()).called(greaterThan(0));
    verifyNever(() => repo.generateResume(force: any(named: 'force')));
  });

  /// #1782 — the note came from `verified || attested`, and on this screen the
  /// summary was read in LEAN mode, where `attested` is never populated. So it
  /// was really `verified`: every worker with a confirmed profile was told
  /// "Complete Verification Done" though nobody had checked their profile, and
  /// everyone else got the "Unverified" copy #1586 forbids outright.
  group('the verification note is ATTESTATION, never the lifecycle flag (#1782)',
      () {
    testWidgets('a confirmed but UNATTESTED worker sees no note at all',
        (WidgetTester tester) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'CNC Turner',
          // The lifecycle flag is ON — this is the confirmed worker the bug
          // mislabelled — and attestation is off, which is the real state.
          verified: true,
          strengthSignals: 0,
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );

      expect(find.textContaining(kResumeVerifiedNote), findsNothing,
          reason: 'nobody has checked this profile');
      expect(find.textContaining('Verification baaki hai'), findsNothing,
          reason: '#1586: an unattested profile gets NO "Unverified" copy');
    });

    testWidgets('an ATTESTED worker sees the note, on the current card only',
        (WidgetTester tester) async {
      // The facts matter: the spec row (and so the note) is drawn only under a
      // card that has a fact line, which is the shape a real confirmed profile
      // has.
      summaryRepo = _FakeSummary(
        const ProfileSummary(
          tradeLabel: 'CNC Turner',
          city: 'Pune MIDC',
          machines: <String>['Fanuc'],
          experienceYears: 3,
          attested: true,
          strengthSignals: 0,
        ),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[
            item(id: 'r2', day: 20, current: true),
            item(id: 'r1', day: 12),
          ],
        ),
      );

      // ONE note for TWO cards: an older file must not carry a claim about the
      // profile that is vouched for today.
      expect(find.textContaining(kResumeVerifiedNote), findsOneWidget);
    });

    testWidgets('no card ever shows the "Verification baaki hai" copy',
        (WidgetTester tester) async {
      summaryRepo = _FakeSummary(
        const ProfileSummary(strengthSignals: 0),
      );
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[
            item(id: 'r2', day: 20, current: true),
            item(id: 'r1', day: 12),
          ],
        ),
      );

      expect(find.textContaining('Verification baaki hai'), findsNothing);
      expect(find.textContaining(kResumeVerifiedNote), findsNothing);
    });

    testWidgets('the screen READS attestation — a lean read could never be true',
        (WidgetTester tester) async {
      final _FakeSummary fake = _FakeSummary(
        const ProfileSummary(attested: true, strengthSignals: 0),
      );
      summaryRepo = fake;
      await pump(
        tester,
        ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );

      expect(fake.askedForExtras, isTrue,
          reason: 'attested stays false in lean mode, so the note would be dead '
              'code and the old fallback to `verified` would creep back');
    });
  });

  /// #1785 — the unfinished-profile card pushed `Routes.tradeForm` directly,
  /// the one road into the form that skipped `openTradeFormWithTier`. With
  /// tiers live, a worker the server answered `needs_choice` for went straight
  /// into the full walk and never saw the Easy / Medium / Hard chooser.
  group('the draft card goes through the tier gate (#1785)', () {
    /// A summary with missing fields, which is what makes the card appear.
    ProfileSummary draftSummary() => const ProfileSummary(
          strengthSignals: 2,
          strengthMax: 10,
          missingFields: <String>['machines'],
        );

    Future<GoRouter> pumpRouted(WidgetTester tester) async {
      when(() => repo.loadResumeHistory()).thenAnswer(
        (_) async => ResumeHistory(
          items: <ResumeHistoryItem>[item(id: 'r1', day: 20, current: true)],
        ),
      );
      tester.view.physicalSize = const Size(420, 2200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: '/',
        routes: <RouteBase>[
          GoRoute(path: '/', builder: (_, __) => const ResumeHistoryScreen()),
          GoRoute(
            path: Routes.tierChoice,
            builder: (_, __) =>
                const Scaffold(body: Center(child: Text('TIER CHOOSER'))),
          ),
          GoRoute(
            path: Routes.tradeForm,
            builder: (_, __) =>
                const Scaffold(body: Center(child: Text('TRADE FORM'))),
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
      );
      await tester.pump();
      await tester.pump();
      return router;
    }

    Future<void> tapContinue(WidgetTester tester) async {
      await tester.ensureVisible(find.text(kResumeDraftCta));
      await tester.pump();
      await tester.tap(find.text(kResumeDraftCta));
      // `openTradeFormWithTier` awaits `loadTierState()` before navigating.
      await tester.pump();
      await tester.pumpAndSettle();
    }

    testWidgets('needs_choice → Continue shows the tier chooser',
        (WidgetTester tester) async {
      summaryRepo = _FakeSummary(draftSummary());
      locator.registerFactory<TradeFormRepository>(
        () => _FakeTiers(
          const TierState(
            enabled: true,
            needsChoice: true,
            tiers: <TierEstimate>[
              TierEstimate(
                tier: ProfilingTier.easy,
                minMinutes: 3,
                maxMinutes: 5,
              ),
            ],
          ),
        ),
      );
      await pumpRouted(tester);
      await tapContinue(tester);

      expect(find.text('TIER CHOOSER'), findsOneWidget);
      expect(find.text('TRADE FORM'), findsNothing);
    });

    testWidgets('any other answer → Continue opens the form, exactly as today',
        (WidgetTester tester) async {
      summaryRepo = _FakeSummary(draftSummary());
      locator.registerFactory<TradeFormRepository>(
        () => _FakeTiers(TierState.disabled),
      );
      await pumpRouted(tester);
      await tapContinue(tester);

      expect(find.text('TRADE FORM'), findsOneWidget);
      expect(find.text('TIER CHOOSER'), findsNothing);
    });
  });
}

/// Answers only the one question `openTradeFormWithTier` asks. Hand-written
/// rather than a mock so the tier gate's "never throws" contract is honoured
/// without stubbing every other member of the repository.
class _FakeTiers implements TradeFormRepository {
  _FakeTiers(this._state);

  final TierState _state;

  @override
  Future<TierState> loadTierState() async => _state;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('not used by the tier gate: ${invocation.memberName}');
}

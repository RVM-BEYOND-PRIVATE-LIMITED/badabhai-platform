import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/core/widgets/bb_avatar.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_chip.dart';
import 'package:payer_app/core/widgets/bb_searchable_dropdown_field.dart';
import 'package:payer_app/core/widgets/bb_status_view.dart';
import 'package:payer_app/features/find/presentation/cubit/candidate_search_cubit.dart';
import 'package:payer_app/features/find/presentation/cubit/find_cubit.dart';
import 'package:payer_app/features/find/presentation/find_screen.dart';
import 'package:payer_app/features/find/presentation/reveal_args.dart';
import 'package:payer_app/features/find/presentation/widgets/candidate_card.dart';
import 'package:payer_app/features/find/presentation/widgets/find_pinned_list.dart';
import 'package:payer_app/features/find/presentation/widgets/find_view_switch.dart';
import 'package:payer_app/features/find/presentation/widgets/unlock_button.dart';
import 'package:payer_app/features/jobs/presentation/agency_jobs_screen.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2593 (M5) — Find and unlock fixes:
///  - Applicants opens the job that was tapped (it always opened the first);
///  - the unlock button locks while its request is in flight: one request per
///    tap, an inline spinner at a locked width;
///  - a failed unlock is a message, the list stays (it became an error page),
///    and the card shakes once with the error haptic;
///  - the page title once, then the switch with its sliding thumb;
///  - the filters and counts pinned, with a soft shadow once the list is under;
///  - the 360dp card: a 40dp avatar and the action in a full-width footer;
///  - the filter sheet clears the gesture bar, and its role picker searches;
///  - and at 360×640 nothing overflows.

final Map<String, dynamic> _fixture = jsonDecode(
  File('../../packages/types/fixtures/candidate-search-contract.json')
      .readAsStringSync(),
) as Map<String, dynamic>;

final CandidateFilters _fixtureFilters =
    CandidateFilters.tryFromJson(_fixture['filters'] as Map<String, dynamic>)!;

const String _light = 'HapticFeedbackType.lightImpact';
const String _jobA = '11111111-1111-4111-8111-111111111111';
const String _jobB = '22222222-2222-4222-8222-222222222222';

String _workerId(int i) =>
    'aaaaaaaa-bbbb-4ccc-8ddd-${i.toString().padLeft(12, '0')}';

/// An all-candidates row. [long] fills every fact with the longest copy a real
/// row can carry — the 360dp worst case.
CandidateSearchRow _row(int i, {bool long = false, bool sample = false}) =>
    CandidateSearchRow(
      workerId: _workerId(i),
      matchesFilters: true,
      matchTier: long ? 2 : 1,
      role: LabelledId(
        id: 'mskill_cnc_turner',
        label: long
            ? 'Senior CNC Turner-cum-VMC Setter Operator (Fanuc, Siemens)'
            : 'CNC Turner',
      ),
      otherRoles: long
          ? const <LabelledId>[
              LabelledId(
                  id: 'r1', label: 'Conventional Lathe Machine Operator'),
              LabelledId(
                  id: 'r2', label: 'Coordinate Measuring Machine Inspector'),
              LabelledId(
                  id: 'r3', label: 'Tool Room Surface Grinding Machinist'),
              LabelledId(id: 'r4', label: 'Production Line Quality Supervisor'),
            ]
          : const <LabelledId>[],
      skillMonths: 48,
      industry: LabelledId(
        id: 'ind_industrial_manufacturing',
        label: long
            ? 'Industrial Manufacturing and Heavy Engineering Fabrication'
            : 'Industrial Manufacturing',
      ),
      industryMonths: 54,
      city: long ? 'Pimpri-Chinchwad MIDC Bhosari Industrial Area' : 'Pune',
      tradeLevels: long
          ? const <CandidateTradeLevel>[
              CandidateTradeLevel(
                skillId: 'mskill_cnc_turner',
                skillLabel: 'CNC Turner',
                tradeLevel: 'setter',
                tradeLevelLabel: 'Setter-cum-Programmer (Level 4 certified)',
                levelConfirmed: true,
              ),
            ]
          : const <CandidateTradeLevel>[],
      isSample: sample,
    );

/// A per-job applicant. [long] is the 360dp worst case: Hot, a related-skill
/// match, "Level not confirmed" and two soft signals.
Applicant _applicant(int i, {bool long = false, bool unlocked = false}) =>
    Applicant(
      workerId: 'cccccccc-dddd-4eee-8fff-${i.toString().padLeft(12, '0')}',
      rank: i + 1,
      score: 0.9,
      hot: long,
      pushEligible: false,
      tradeLabel:
          long ? 'Senior CNC Turner-cum-VMC Setter Operator' : 'CNC Setter',
      cityLabel: long ? 'Pimpri-Chinchwad MIDC Bhosari' : 'Pune',
      experienceBand: long ? '10+ yrs' : '3–5 yrs',
      matchTier: long ? 2 : 1,
      matchedSkillLabel: long ? 'Conventional Lathe Machine Operator' : null,
      levelFit: long ? 'not_confirmed' : null,
      components: long
          ? const <ApplicantSignal>[
              ApplicantSignal(
                signal: 'recency',
                raw: 1,
                weight: 1,
                reason: 'Active on BadaBhai this week',
              ),
              ApplicantSignal(
                signal: 'tenure',
                raw: 1,
                weight: 1,
                reason: 'Long tenure in the same industry',
              ),
            ]
          : const <ApplicantSignal>[],
      unlocked: unlocked,
      unlockId: unlocked ? 'held-$i' : null,
    );

JobPosting _posting(String id, String title) => JobPosting(
      id: id,
      title: title,
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.live,
      verified: false,
      boosted: false,
      wireStatus: 'open',
    );

AgencyJobView _agencyJob(String id, String title) => AgencyJobView(
      id: id,
      status: 'open',
      tradeKey: 'cnc_operator',
      title: title,
      city: 'Pune',
      applicantsReceived: 1,
    );

/// One scripted seam for both Find views and the Jobs tab: the search, the
/// per-job feed, and unlocks that can be held in flight, refused or fail.
class _M5Api extends MockPayerApiClient {
  List<CandidateSearchRow> rows = <CandidateSearchRow>[_row(0), _row(1)];

  /// The counts the search reports (null: everyone, unfiltered).
  CandidateSearchPage Function(List<CandidateSearchRow> rows)? page;
  List<PayerUnlock> history = const <PayerUnlock>[];
  List<JobPosting> jobs = <JobPosting>[
    _posting(_jobA, 'CNC Setter'),
    _posting(_jobB, 'VMC Operator'),
  ];
  List<AgencyJobView> agencyJobs = const <AgencyJobView>[];
  Map<String, List<Applicant>> applicantsByJob = <String, List<Applicant>>{
    _jobA: <Applicant>[_applicant(0), _applicant(1)],
    _jobB: <Applicant>[_applicant(7)],
  };

  /// While set, every unlock waits on it — a request held in flight.
  Completer<UnlockResult>? gate;

  /// While set, every unlock throws it — an outage.
  Object? unlockError;
  UnlockResult unlockResult = const UnlockResult.granted(unlockId: 'unl-m5');

  final List<CandidateSearchQuery> searches = <CandidateSearchQuery>[];
  final List<String> applicantFetches = <String>[];
  final List<({String workerId, String? jobId})> unlockCalls =
      <({String workerId, String? jobId})>[];

  @override
  Future<CandidateSearchPage> searchCandidates(
      CandidateSearchQuery query) async {
    searches.add(query);
    return page?.call(rows) ??
        CandidateSearchPage(
          total: rows.length,
          matched: rows.length,
          unrecorded: 0,
          filtered: false,
          strict: false,
          candidates: rows,
          nextCursor: null,
        );
  }

  @override
  Future<CandidateFilters> fetchCandidateFilters() async => _fixtureFilters;

  @override
  Future<List<PayerUnlock>> fetchOwnUnlocks() async => history;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async => jobs;

  @override
  Future<List<AgencyJobView>> fetchAgencyJobs() async => agencyJobs;

  @override
  Future<List<Applicant>> fetchApplicants(String jobId) async {
    applicantFetches.add(jobId);
    return applicantsByJob[jobId] ?? const <Applicant>[];
  }

  @override
  Future<UnlockResult> unlock({required String workerId, String? jobId}) async {
    unlockCalls.add((workerId: workerId, jobId: jobId));
    if (unlockError != null) throw unlockError!;
    final Completer<UnlockResult>? held = gate;
    if (held != null) return held.future;
    return unlockResult;
  }
}

Widget _host(Widget body, {bool reduced = false}) => MaterialApp(
      theme: AppTheme.light(),
      builder: (BuildContext context, Widget? app) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
        child: app!,
      ),
      home: Scaffold(body: body),
    );

/// A 360×640dp phone.
void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

void main() {
  late _M5Api api;
  late List<RevealArgs> revealed;
  late List<String> haptics;
  CandidateSearchCubit? searchCubit;

  setUp(() async {
    haptics = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      if (call.method == 'HapticFeedback.vibrate') {
        haptics.add(call.arguments as String);
      }
      return null;
    });
    await GetIt.instance.reset();
    api = _M5Api();
    revealed = <RevealArgs>[];
    searchCubit = null;
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    // The REAL per-job feed (the mock seam forces the MOCK one), and the
    // search cubit captured so a test can drive a query.
    locator.unregister<FindCubit>();
    locator.registerFactory<FindCubit>(
      () => FindCubit(locator<PayerApiClient>(), useRealFeed: true),
    );
    locator.unregister<CandidateSearchCubit>();
    locator.registerFactory<CandidateSearchCubit>(
      () => searchCubit = CandidateSearchCubit(locator<PayerApiClient>()),
    );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<void> pumpFind(
    WidgetTester tester, {
    FindView view = FindView.allCandidates,
    String? jobId,
    bool reduced = false,
  }) async {
    await tester.pumpWidget(_host(
      FindScreen(
          onReveal: revealed.add, initialView: view, initialJobId: jobId),
      reduced: reduced,
    ));
    await tester.pumpAndSettle();
  }

  /// The view's vertical list (the job selector strip, when shown, is the
  /// pinned header's — above it).
  Finder list() => find
      .descendant(
        of: find.byType(FindPinnedList),
        matching: find.byType(Scrollable),
      )
      .last;

  /// The outermost transform of the card keyed [key]: its [BbShake].
  double shakeOffset(WidgetTester tester, Key key) => tester
      .widget<Transform>(find
          .descendant(of: find.byKey(key), matching: find.byType(Transform))
          .first)
      .transform
      .getTranslation()
      .x;

  group('acceptance — 360×640 shows no overflow', () {
    testWidgets(
        'All candidates: the longest facts, a sample, a held grant, '
        'the tallest pinned header — every card', (WidgetTester tester) async {
      _phone(tester);
      api
        ..rows = <CandidateSearchRow>[
          for (int i = 0; i < 6; i++) _row(i, long: true, sample: i == 1),
        ]
        ..history = <PayerUnlock>[
          PayerUnlock(
            unlockId: 'held-2',
            workerId: _workerId(2),
            status: 'granted',
            expiresAt: DateTime.now()
                .toUtc()
                .add(const Duration(days: 7))
                .toIso8601String(),
          ),
        ]
        // Filtered + strict + not-recorded: every count line and the note.
        ..page = (List<CandidateSearchRow> rows) => CandidateSearchPage(
              total: 12345,
              matched: 9876,
              unrecorded: 543,
              filtered: true,
              strict: true,
              candidates: rows,
              nextCursor: 'more',
            );
      await pumpFind(tester);
      // ignore: discarded_futures
      searchCubit!.applyQuery(const CandidateSearchQuery(
        skillIds: <String>['mskill_cnc_turner'],
        experience: '1_3',
        city: 'Pune',
        strict: true,
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('Filters · 3'), findsOneWidget);

      // The held grant's View card, then on to the last row.
      await tester.scrollUntilVisible(find.text('View'), 250,
          scrollable: list());
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.byKey(const Key('candidate_load_more')),
        250,
        scrollable: list(),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets(
        'Applicants: Hot, related, level, signals and a long job '
        'selector — every card', (WidgetTester tester) async {
      _phone(tester);
      api
        ..jobs = <JobPosting>[
          _posting(_jobA, 'Senior CNC Turner-cum-VMC Setter — Night shift'),
          _posting(
              _jobB, 'Tool Room Grinding Machinist (Surface, Cylindrical)'),
        ]
        ..applicantsByJob = <String, List<Applicant>>{
          _jobA: <Applicant>[
            for (int i = 0; i < 6; i++)
              _applicant(i, long: true, unlocked: i == 2),
          ],
        };
      await pumpFind(tester, view: FindView.applicants);
      expect(tester.takeException(), isNull);
      expect(find.byType(BbStatusView), findsNothing);

      // The unlocked applicant's View card, then on to the last row.
      await tester.scrollUntilVisible(find.text('View'), 250,
          scrollable: list());
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.text(_applicant(5).maskedLabel),
        250,
        scrollable: list(),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('the MOCK feed card fits too', (WidgetTester tester) async {
      _phone(tester);
      locator.unregister<FindCubit>();
      locator.registerFactory<FindCubit>(
        () => FindCubit(locator<PayerApiClient>(), useRealFeed: false),
      );
      await pumpFind(tester, view: FindView.applicants);
      expect(tester.takeException(), isNull);

      await tester.fling(list(), const Offset(0, -3000), 3000);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('the filter sheet and the role picker fit — keyboard up too',
        (WidgetTester tester) async {
      _phone(tester);
      await pumpFind(tester);

      await tester.tap(find.byKey(const Key('candidate_filters_open')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      await tester.tap(find.descendant(
        of: find.byKey(const Key('filter_role')),
        matching: find.byType(InputDecorator),
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      // The keyboard takes half the phone: the list gives way, the sheet
      // never overflows.
      tester.view.viewInsets = const FakeViewPadding(bottom: 320);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
          find.byKey(BbSearchableDropdownField.searchFieldKey), findsOneWidget);
    });

    testWidgets(
        'the card: a 40dp avatar, "Unlock" with a lock icon in a '
        'full-width footer — no price on it', (WidgetTester tester) async {
      _phone(tester);
      await pumpFind(tester);

      final Finder card = find.byKey(ValueKey<String>(_workerId(0)));
      final Finder avatar =
          find.descendant(of: card, matching: find.byType(BbAvatar));
      final Finder unlock =
          find.descendant(of: card, matching: find.byType(UnlockButton));
      final Finder facts =
          find.descendant(of: card, matching: find.byType(Row)).first;

      expect(tester.getSize(avatar), const Size(40, 40));
      expect(
          find.descendant(
              of: unlock, matching: find.byIcon(Icons.lock_rounded)),
          findsOneWidget);
      expect(find.descendant(of: unlock, matching: find.text(kUnlockLabel)),
          findsOneWidget);
      expect(find.descendant(of: card, matching: find.textContaining('credit')),
          findsNothing,
          reason: 'the confirm dialog states the 1-credit spend (#2589)');
      // Under the facts, as wide as them: the card's full content width.
      expect(tester.getRect(unlock).top,
          greaterThanOrEqualTo(tester.getRect(facts).bottom));
      expect(tester.getSize(unlock).width, tester.getSize(facts).width);
    });

    testWidgets('the applicant card has the same footer and avatar',
        (WidgetTester tester) async {
      _phone(tester);
      await pumpFind(tester, view: FindView.applicants);

      final Finder card = find.byKey(ValueKey<String>(_applicant(0).workerId));
      final Finder unlock =
          find.descendant(of: card, matching: find.byType(UnlockButton));
      final Finder facts =
          find.descendant(of: card, matching: find.byType(Row)).first;
      expect(
          tester.getSize(
              find.descendant(of: card, matching: find.byType(BbAvatar))),
          const Size(40, 40));
      expect(tester.getRect(unlock).top,
          greaterThanOrEqualTo(tester.getRect(facts).bottom));
      expect(tester.getSize(unlock).width, tester.getSize(facts).width);
    });
  });

  group('acceptance — double-tapping unlock sends one request', () {
    testWidgets(
        'a double-tap opens ONE dialog; a double confirm sends ONE '
        'request', (WidgetTester tester) async {
      await pumpFind(tester);
      final Finder unlock = find.text(kUnlockLabel).first;

      // Both taps land in one frame, before the dialog's barrier is built.
      await tester.tap(unlock);
      await tester.tap(unlock, warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.text('Unlock this candidate?'), findsOneWidget);

      final Finder confirm = find.text('Unlock for 1 credit');
      await tester.tap(confirm);
      await tester.pump(const Duration(milliseconds: 40)); // a real double-tap
      await tester.tap(confirm, warnIfMissed: false);
      await tester.pumpAndSettle();

      expect(api.unlockCalls, hasLength(1));
      expect(revealed, hasLength(1));
    });

    testWidgets(
        'two activations in one frame (keyboard, screen reader) open ONE '
        'dialog', (WidgetTester tester) async {
      await pumpFind(tester, view: FindView.applicants);
      // The Navigator absorbs a second POINTER in the frame of a push; a key
      // or an accessibility action is not a pointer, so the button locks.
      final VoidCallback activate = tester
          .widget<BbButton>(find.descendant(
            of: find.byType(UnlockButton).first,
            matching: find.byType(BbButton),
          ))
          .onPressed!;
      activate();
      activate();
      await tester.pumpAndSettle();
      expect(find.text('Unlock this candidate?'), findsOneWidget);

      await tester.tap(find.text('Unlock for 1 credit'));
      await tester.pumpAndSettle();
      expect(api.unlockCalls, hasLength(1));
    });

    for (final FindView view in FindView.values) {
      testWidgets(
          '${view.name}: in flight, the button spins at a locked '
          'width and ignores taps', (WidgetTester tester) async {
        api.gate = Completer<UnlockResult>();
        await pumpFind(tester, view: view);
        final Finder button = find.byType(UnlockButton).first;
        final Size before = tester.getSize(button);

        await tester.tap(find.text(kUnlockLabel).first);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Unlock for 1 credit'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400)); // dialog gone
        expect(find.text('Unlock this candidate?'), findsNothing);
        expect(api.unlockCalls, hasLength(1));

        // The inline spinner; the label stays and the width does not move.
        expect(
          find.descendant(
            of: button,
            matching: find.byType(CircularProgressIndicator),
          ),
          findsOneWidget,
        );
        expect(find.descendant(of: button, matching: find.text(kUnlockLabel)),
            findsOneWidget);
        expect(tester.getSize(button), before);

        // Taps on it now open nothing and send nothing.
        await tester.tap(button, warnIfMissed: false);
        await tester.pump(const Duration(milliseconds: 60));
        await tester.tap(button, warnIfMissed: false);
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.text('Unlock this candidate?'), findsNothing);
        expect(api.unlockCalls, hasLength(1));

        api.gate!.complete(const UnlockResult.granted(unlockId: 'unl-m5'));
        await tester.pumpAndSettle();
        expect(api.unlockCalls, hasLength(1));
        expect(revealed.single.unlockId, 'unl-m5');
      });
    }
  });

  group('acceptance — Applicants opens the tapped job', () {
    const AppSession company = AppSession(
      role: PayerRole.company,
      account: PayerAccount(
        name: 'Kalyani Industries',
        plan: 'Starter',
        initials: 'KI',
      ),
    );

    Future<void> tapNav(WidgetTester tester, String label) async {
      await tester.tap(find.descendant(
        of: find.byType(BbBottomNav),
        matching: find.text(label),
      ));
      await tester.pumpAndSettle();
    }

    testWidgets(
        'Jobs → "Applicants" on the SECOND job opens Find on it — '
        'and on the first, the first', (WidgetTester tester) async {
      api.applicantsByJob = <String, List<Applicant>>{
        _jobA: <Applicant>[_applicant(0)],
        _jobB: <Applicant>[_applicant(7)],
      };
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: BlocProvider<AppSessionCubit>.value(
          value: locator<AppSessionCubit>(),
          child: const AppShell(session: company),
        ),
      ));
      await tester.pumpAndSettle();
      await tapNav(tester, 'Jobs');

      await tester.tap(find.text('Applicants').at(1));
      await tester.pumpAndSettle();

      expect(
        tester.widget<FindViewSwitch>(find.byType(FindViewSwitch)).selected,
        FindView.applicants,
      );
      expect(find.text('CANDIDATES FOR VMC OPERATOR'), findsOneWidget);
      expect(find.text(_applicant(7).maskedLabel), findsOneWidget);
      expect(
        tester
            .widget<BbChip>(find.widgetWithText(BbChip, 'VMC Operator'))
            .selected,
        isTrue,
      );
      expect(api.applicantFetches, <String>[_jobB],
          reason: 'it no longer opens on the first open job');

      await tapNav(tester, 'Jobs');
      await tester.tap(find.text('Applicants').at(0));
      await tester.pumpAndSettle();

      expect(find.text('CANDIDATES FOR CNC SETTER'), findsOneWidget);
      expect(api.applicantFetches.last, _jobA);
    });

    testWidgets('an agency job card hands Find its own id',
        (WidgetTester tester) async {
      api.agencyJobs = <AgencyJobView>[
        _agencyJob('agency-a', 'CNC Operator — Day shift'),
        _agencyJob('agency-b', 'Fitter — Night shift'),
      ];
      final List<String?> tapped = <String?>[];
      await tester.pumpWidget(
        _host(AgencyJobsView(onPost: () {}, onApplicants: tapped.add)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Applicants').at(1));
      await tester.pumpAndSettle();

      expect(tapped, <String?>['agency-b']);
    });
  });

  group('a failed unlock keeps the list', () {
    testWidgets(
        'an outage: a retry toast, the list stays, one shake and the '
        'error haptic', (WidgetTester tester) async {
      api.unlockError = const PayerApiException(503);
      await pumpFind(tester, view: FindView.applicants);
      final Key card = ValueKey<String>(_applicant(0).workerId);

      await tester.tap(find.text(kUnlockLabel).first);
      await tester.pumpAndSettle();
      haptics.clear();
      await tester.tap(find.text('Unlock for 1 credit'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      // Mid-shake: the card is off its rest position, by at most 6px.
      final double mid = shakeOffset(tester, card);
      expect(mid.abs(), greaterThan(0));
      expect(mid.abs(), lessThanOrEqualTo(AppMotion.shakeTravel));

      await tester.pumpAndSettle();
      expect(shakeOffset(tester, card), 0, reason: 'once, then at rest');
      expect(haptics, <String>[_light, _light, _light],
          reason: 'the confirm press, then AppHaptics.error (two ticks)');

      expect(find.text('Something went wrong'), findsOneWidget);
      // The feed is still there — never the error page.
      expect(find.byType(BbStatusView), findsNothing);
      expect(find.text(_applicant(0).maskedLabel), findsOneWidget);
      expect(find.text(_applicant(1).maskedLabel), findsOneWidget);
      expect(find.text(kUnlockLabel), findsNWidgets(2),
          reason: 'Retry is one tap on the same card');
    });

    testWidgets(
        'a neutral deny on All candidates: the message, the list, '
        'the nudge', (WidgetTester tester) async {
      api.unlockResult = const UnlockResult.unavailable();
      await pumpFind(tester);
      final Key card = ValueKey<String>(_workerId(0));

      await tester.tap(find.text(kUnlockLabel).first);
      await tester.pumpAndSettle();
      haptics.clear();
      await tester.tap(find.text('Unlock for 1 credit'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(shakeOffset(tester, card).abs(), greaterThan(0));
      await tester.pumpAndSettle();
      expect(haptics, <String>[_light, _light, _light]);
      expect(find.text("Couldn't unlock"), findsOneWidget);
      expect(find.byType(CandidateCard), findsNWidgets(2));
      expect(revealed, isEmpty);
    });

    testWidgets('reduced motion: no shake — the haptic still says it',
        (WidgetTester tester) async {
      api.unlockError = const PayerApiException(503);
      await pumpFind(tester, view: FindView.applicants, reduced: true);
      final Key card = ValueKey<String>(_applicant(0).workerId);

      await tester.tap(find.text(kUnlockLabel).first);
      await tester.pumpAndSettle();
      haptics.clear();
      await tester.tap(find.text('Unlock for 1 credit'));
      await tester.pump();
      for (int i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 40));
        expect(shakeOffset(tester, card), 0);
      }
      await tester.pumpAndSettle();
      expect(haptics, <String>[_light, _light, _light]);
      expect(find.text('Something went wrong'), findsOneWidget);
    });
  });

  group('the page title first, then the switch', () {
    testWidgets('the title shows ONCE, above the switch, in both views',
        (WidgetTester tester) async {
      await pumpFind(tester);

      expect(find.text(kFindTitle), findsOneWidget);
      expect(find.text('ALL CANDIDATES'), findsNothing,
          reason: 'the switch already names the view');
      expect(
        tester.getBottomLeft(find.text(kFindTitle)).dy,
        lessThanOrEqualTo(tester.getTopLeft(find.byType(FindViewSwitch)).dy),
      );

      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await tester.pumpAndSettle();

      // Both views are mounted now — still one title in the whole tree.
      expect(find.text(kFindTitle, skipOffstage: false), findsOneWidget);
    });

    testWidgets('the thumb slides 220ms onto the picked half',
        (WidgetTester tester) async {
      await pumpFind(tester);
      AnimatedSlide thumb() =>
          tester.widget<AnimatedSlide>(find.byKey(FindViewSwitch.thumbKey));
      double thumbX() => tester
          .getTopLeft(find.descendant(
            of: find.byKey(FindViewSwitch.thumbKey),
            matching: find.byType(DecoratedBox),
          ))
          .dx;

      expect(AppMotion.tab, const Duration(milliseconds: 220));
      expect(thumb().duration, AppMotion.tab);
      expect(thumb().offset, Offset.zero);
      final double start = thumbX();

      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 110));
      final double mid = thumbX();
      await tester.pumpAndSettle();
      final double end = thumbX();

      expect(thumb().offset, const Offset(1, 0));
      expect(mid, greaterThan(start));
      expect(mid, lessThan(end));
      expect(
          end,
          closeTo(
              tester
                  .getTopLeft(find.byKey(const Key('find_view_applicants')))
                  .dx,
              0.5));
    });

    testWidgets('reduced motion: the thumb moves at once',
        (WidgetTester tester) async {
      await pumpFind(tester, reduced: true);

      expect(
        tester
            .widget<AnimatedSlide>(find.byKey(FindViewSwitch.thumbKey))
            .duration,
        Duration.zero,
      );
    });
  });

  group('filters and counts pinned at the top', () {
    testWidgets(
        'All candidates: they stay put while the list scrolls under; '
        'a soft shadow fades in (160ms) and out', (WidgetTester tester) async {
      api.rows = <CandidateSearchRow>[for (int i = 0; i < 20; i++) _row(i)];
      await pumpFind(tester);
      final Finder filters = find.byKey(const Key('candidate_filters_open'));
      final Finder badge = find.byKey(const Key('candidate_count_badge'));
      AnimatedOpacity shadow() =>
          tester.widget<AnimatedOpacity>(find.byKey(FindPinnedList.shadowKey));
      final Offset filtersAt = tester.getTopLeft(filters);
      final Offset badgeAt = tester.getTopLeft(badge);

      expect(AppMotion.headerShadow, const Duration(milliseconds: 160));
      expect(shadow().duration, AppMotion.headerShadow);
      expect(shadow().opacity, 0, reason: 'nothing is under the header yet');

      await tester.drag(list(), const Offset(0, -500));
      await tester.pumpAndSettle();

      expect(tester.getTopLeft(filters), filtersAt);
      expect(tester.getTopLeft(badge), badgeAt);
      expect(find.byKey(ValueKey<String>(_workerId(0))), findsNothing,
          reason: 'the first card scrolled away under the header');
      expect(shadow().opacity, 1);

      await tester.drag(list(), const Offset(0, 3000));
      await tester.pumpAndSettle();
      expect(shadow().opacity, 0);
    });

    testWidgets('reduced motion: the shadow cuts in at once',
        (WidgetTester tester) async {
      api.rows = <CandidateSearchRow>[for (int i = 0; i < 20; i++) _row(i)];
      await pumpFind(tester, reduced: true);

      expect(
        tester
            .widget<AnimatedOpacity>(find.byKey(FindPinnedList.shadowKey))
            .duration,
        Duration.zero,
      );
    });

    testWidgets('Applicants: the job, its selector and the count stay put',
        (WidgetTester tester) async {
      api.applicantsByJob = <String, List<Applicant>>{
        _jobA: <Applicant>[for (int i = 0; i < 20; i++) _applicant(i)],
      };
      await pumpFind(tester, view: FindView.applicants);
      final Finder count =
          find.textContaining('matched candidates', findRichText: true);
      final Finder selector = find.widgetWithText(BbChip, 'VMC Operator');
      final Offset countAt = tester.getTopLeft(count);
      final Offset selectorAt = tester.getTopLeft(selector);

      await tester.drag(list(), const Offset(0, -500));
      await tester.pumpAndSettle();

      expect(tester.getTopLeft(count), countAt);
      expect(tester.getTopLeft(selector), selectorAt);
      expect(find.text('CANDIDATES FOR CNC SETTER'), findsOneWidget);
      expect(find.text(_applicant(0).maskedLabel), findsNothing);
    });
  });

  group('the filter sheet', () {
    testWidgets('clears the gesture bar', (WidgetTester tester) async {
      _phone(tester);
      const double bar = 48;
      tester.view.padding = const FakeViewPadding(bottom: bar);
      tester.view.viewPadding = const FakeViewPadding(bottom: bar);
      await pumpFind(tester);

      await tester.tap(find.byKey(const Key('candidate_filters_open')));
      await tester.pumpAndSettle();

      expect(
        tester.getBottomLeft(find.byKey(const Key('filters_apply'))).dy,
        lessThanOrEqualTo(640 - bar),
      );

      // The role picker's sheet clears it too.
      await tester.tap(find.descendant(
        of: find.byKey(const Key('filter_role')),
        matching: find.byType(InputDecorator),
      ));
      await tester.pumpAndSettle();
      expect(
        tester.getBottomLeft(find.byType(ListView).last).dy,
        lessThanOrEqualTo(640 - bar),
      );
    });

    testWidgets(
        'the role picker searches: type to narrow, pick, and the '
        'search sends it', (WidgetTester tester) async {
      await pumpFind(tester);
      await tester.tap(find.byKey(const Key('candidate_filters_open')));
      await tester.pumpAndSettle();
      final Finder roleField = find.byKey(const Key('filter_role'));
      expect(find.descendant(of: roleField, matching: find.text('Any role')),
          findsOneWidget);

      await tester.tap(find.descendant(
          of: roleField, matching: find.byType(InputDecorator)));
      await tester.pumpAndSettle();
      final Finder search =
          find.byKey(BbSearchableDropdownField.searchFieldKey);
      expect(search, findsOneWidget);
      expect(find.widgetWithText(ListTile, 'CNC Turner'), findsOneWidget);
      expect(find.widgetWithText(ListTile, 'VMC Operator'), findsOneWidget);

      await tester.enterText(search, 'vmc');
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ListTile, 'CNC Turner'), findsNothing);
      expect(find.widgetWithText(ListTile, 'VMC Operator'), findsOneWidget);

      await tester.enterText(search, 'zzz');
      await tester.pumpAndSettle();
      expect(find.text('No role matches. Try another word.'), findsOneWidget);

      await tester.enterText(search, 'OPERATOR');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ListTile, 'VMC Operator'));
      await tester.pumpAndSettle();

      expect(
          find.descendant(of: roleField, matching: find.text('VMC Operator')),
          findsOneWidget);
      await tester.tap(find.byKey(const Key('filters_apply')));
      await tester.pumpAndSettle();
      expect(api.searches.last.skillIds, <String>['mskill_vmc_operator']);
    });
  });
}

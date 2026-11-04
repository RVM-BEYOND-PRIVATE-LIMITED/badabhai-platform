import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/error/payer_failure.dart';
import 'package:payer_app/core/util/name_mask.dart';
import 'package:payer_app/core/widgets/bb_refresh.dart';
import 'package:payer_app/core/widgets/bb_skeleton.dart';
import 'package:payer_app/features/find/presentation/cubit/candidate_search_cubit.dart';
import 'package:payer_app/features/find/presentation/cubit/find_cubit.dart';
import 'package:payer_app/features/find/presentation/find_screen.dart';
import 'package:payer_app/features/find/presentation/reveal_args.dart';
import 'package:payer_app/features/find/presentation/widgets/unlock_button.dart';

/// #2592 (M4) on Find: both views keep their rows while they refresh, a job
/// or filter change dims the old rows under a thin bar instead of blanking
/// the list, a refresh failure keeps the rows and says why, and the skeleton
/// is shaped like candidate cards.
class _Api extends MockPayerApiClient {
  List<JobPosting> jobs = <JobPosting>[
    _job(_jobA),
    _job(_jobB, 'VMC Operator')
  ];
  Map<String, List<Applicant>> applicants = <String, List<Applicant>>{
    _jobA: <Applicant>[_applicant(_workerA)],
    _jobB: <Applicant>[_applicant(_workerB)],
  };
  Object? throwOnApplicants;
  Object? throwOnJobs;

  /// Every `POST /payer/unlocks` sent: (workerId, jobId).
  final List<(String, String?)> unlockCalls = <(String, String?)>[];

  /// Per-job gates: an applicant read for a gated job waits on it.
  final Map<String, Completer<List<Applicant>>> applicantGates =
      <String, Completer<List<Applicant>>>{};
  final List<String> applicantFetches = <String>[];

  Future<CandidateSearchPage> Function(CandidateSearchQuery q) onSearch =
      (CandidateSearchQuery q) async =>
          _page(<CandidateSearchRow>[_row(_workerA), _row(_workerB)]);
  final List<CandidateSearchQuery> searches = <CandidateSearchQuery>[];
  int unlockHistoryReads = 0;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    if (throwOnJobs != null) throw throwOnJobs!;
    return jobs;
  }

  @override
  Future<UnlockResult> unlock({required String workerId, String? jobId}) async {
    unlockCalls.add((workerId, jobId));
    return UnlockResult.granted(unlockId: 'unl-$workerId');
  }

  @override
  Future<List<Applicant>> fetchApplicants(String jobId) async {
    applicantFetches.add(jobId);
    final Completer<List<Applicant>>? gate = applicantGates[jobId];
    if (gate != null) return gate.future;
    if (throwOnApplicants != null) throw throwOnApplicants!;
    return applicants[jobId] ?? const <Applicant>[];
  }

  @override
  Future<CandidateSearchPage> searchCandidates(CandidateSearchQuery query) {
    searches.add(query);
    return onSearch(query);
  }

  @override
  Future<List<PayerUnlock>> fetchOwnUnlocks() async {
    unlockHistoryReads++;
    return const <PayerUnlock>[];
  }
}

const String _jobA = '11111111-1111-4111-8111-111111111111';
const String _jobB = '22222222-2222-4222-8222-222222222222';
const String _workerA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const String _workerB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const String _workerC = 'cccccccc-3333-4333-8333-cccccccccccc';

JobPosting _job(String id, [String title = 'CNC Setter']) => JobPosting(
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

Applicant _applicant(String workerId) => Applicant(
      workerId: workerId,
      rank: 1,
      score: 0.9,
      hot: false,
      pushEligible: false,
      tradeLabel: 'CNC Setter',
      cityLabel: 'Pune',
    );

const LabelledId _turner =
    LabelledId(id: 'mskill_cnc_turner', label: 'CNC Turner');

CandidateSearchRow _row(String workerId) => CandidateSearchRow(
      workerId: workerId,
      matchesFilters: true,
      matchTier: null,
      role: _turner,
      otherRoles: const <LabelledId>[],
      skillMonths: 48,
      industry: null,
      industryMonths: null,
      city: 'Pune',
      tradeLevels: const <CandidateTradeLevel>[],
    );

CandidateSearchPage _page(List<CandidateSearchRow> rows, {String? next}) =>
    CandidateSearchPage(
      total: 62,
      matched: 62,
      unrecorded: 0,
      filtered: false,
      strict: false,
      candidates: rows,
      nextCursor: next,
    );

const CandidateSearchQuery _turnerQuery =
    CandidateSearchQuery(skillIds: <String>['mskill_cnc_turner']);

void main() {
  late _Api api;

  setUp(() => api = _Api());

  group('FindCubit (the Applicants feed)', () {
    late FindCubit cubit;
    setUp(() => cubit = FindCubit(api, useRealFeed: true));
    tearDown(() => cubit.close());

    test('refresh re-reads with the rows on screen — never a loading state',
        () async {
      await cubit.load();
      await cubit.selectJob(cubit.state.jobs[1]);
      final List<FindStatus> seen = <FindStatus>[];
      final StreamSubscription<FindState> sub =
          cubit.stream.listen((FindState s) => seen.add(s.status));
      api.applicants[_jobB] = <Applicant>[
        _applicant(_workerB),
        _applicant(_workerC),
      ];

      final PayerFailure? failure = await cubit.refresh();
      await Future<void>.delayed(Duration.zero); // stream delivery
      await sub.cancel();

      expect(failure, isNull);
      expect(seen, isNotEmpty);
      expect(seen, isNot(contains(FindStatus.loading)));
      expect(cubit.state.selectedJob?.id, _jobB,
          reason: 'the job the payer picked is kept while it is still open');
      expect(cubit.state.applicants, hasLength(2));
    });

    test('a failed refresh keeps the rows and hands back the reason', () async {
      await cubit.load();
      api.throwOnApplicants = const PayerApiException(503);

      final PayerFailure? failure = await cubit.refresh();

      expect(failure?.kind, PayerFailureKind.server);
      expect(cubit.state.status, FindStatus.ready);
      expect(cubit.state.applicants.single.workerId, _workerA);
    });

    test('a job switch keeps the old rows (dimmed) until the new ones land',
        () async {
      await cubit.load();
      final Completer<List<Applicant>> gate = Completer<List<Applicant>>();
      api.applicantGates[_jobB] = gate;

      final Future<void> switching = cubit.selectJob(cubit.state.jobs[1]);
      await Future<void>.delayed(Duration.zero);

      expect(cubit.state.status, FindStatus.ready, reason: 'no blank list');
      expect(cubit.state.switchingJobId, _jobB);
      expect(cubit.state.selectedJob?.id, _jobA,
          reason: 'selection moves only once the feed has landed');
      expect(cubit.state.applicants.single.workerId, _workerA);

      gate.complete(<Applicant>[_applicant(_workerB)]);
      await switching;
      expect(cubit.state.switchingJobId, isNull);
      expect(cubit.state.selectedJob?.id, _jobB);
      expect(cubit.state.applicants.single.workerId, _workerB);
    });

    test('a slow earlier switch never lands over a later one', () async {
      api.jobs = <JobPosting>[
        _job(_jobA),
        _job(_jobB, 'VMC Operator'),
        _job('33333333-3333-4333-8333-333333333333', 'Welder'),
      ];
      await cubit.load();
      final Completer<List<Applicant>> slow = Completer<List<Applicant>>();
      api.applicantGates[_jobB] = slow;

      final Future<void> first = cubit.selectJob(cubit.state.jobs[1]);
      await cubit.selectJob(cubit.state.jobs[2]);
      slow.complete(<Applicant>[_applicant(_workerB)]);
      await first;

      expect(cubit.state.selectedJob?.title, 'Welder');
      expect(cubit.state.switchingJobId, isNull);
    });

    group('a refresh while a job switch is loading leaves the switch alone', () {
      Future<void> refreshDuringSwitch({required bool refreshWouldFail}) async {
        await cubit.load();
        final Completer<List<Applicant>> gate = Completer<List<Applicant>>();
        api.applicantGates[_jobB] = gate;
        final Future<void> switching = cubit.selectJob(cubit.state.jobs[1]);
        await Future<void>.delayed(Duration.zero);
        if (refreshWouldFail) {
          api.throwOnJobs = const PayerApiException(503);
        }
        final int fetches = api.applicantFetches.length;

        expect(await cubit.refresh(), isNull,
            reason: 'nothing to report — the switch is the fresh read');
        expect(api.applicantFetches, hasLength(fetches),
            reason: 'no second read of the old job');
        expect(cubit.state.switchingJobId, _jobB);

        gate.complete(<Applicant>[_applicant(_workerB)]);
        await switching;
        expect(cubit.state.switchingJobId, isNull,
            reason: 'the rows never stay dimmed under a bar for good');
        expect(cubit.state.selectedJob?.id, _jobB,
            reason: "the payer's pick is never dropped or snapped back");
        expect(cubit.state.applicants.single.workerId, _workerB);
      }

      test('a refresh that would fail', () async {
        await refreshDuringSwitch(refreshWouldFail: true);
      });

      test('a refresh that would succeed', () async {
        await refreshDuringSwitch(refreshWouldFail: false);
      });
    });

    test('an unlock is filed against the job its row came from', () async {
      // The same worker applied to both jobs.
      api.applicants[_jobB] = <Applicant>[_applicant(_workerA)];
      await cubit.load();
      final Applicant fromJobA = cubit.state.applicants.single;
      await cubit.selectJob(cubit.state.jobs[1]); // landed while confirming

      final UnlockResult result =
          await cubit.unlockApplicant(fromJobA, jobId: _jobA);

      expect(result.granted, isTrue);
      expect(api.unlockCalls.single, (_workerA, _jobA),
          reason: 'never the job selected by the time the payer confirmed');
      expect(cubit.state.applicants.single.unlocked, isFalse,
          reason: "job B's row is not the row that was unlocked");

      await cubit.unlockApplicant(cubit.state.applicants.single, jobId: _jobB);
      expect(api.unlockCalls.last, (_workerA, _jobB));
      expect(cubit.state.applicants.single.unlocked, isTrue);
    });
  });

  group('CandidateSearchCubit (All candidates)', () {
    late CandidateSearchCubit cubit;
    setUp(() => cubit = CandidateSearchCubit(api));
    tearDown(() => cubit.close());

    test('a filter change keeps the rows, dimmed, until the new page lands',
        () async {
      await cubit.load();
      final Completer<CandidateSearchPage> gate =
          Completer<CandidateSearchPage>();
      api.onSearch = (_) => gate.future;

      final Future<void> applying = cubit.applyQuery(_turnerQuery);
      await Future<void>.delayed(Duration.zero);

      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(cubit.state.switchingFilters, isTrue);
      expect(cubit.state.rows, hasLength(2), reason: 'never a blank list');
      expect(cubit.state.query, _turnerQuery, reason: 'the bar shows the pick');
      expect(cubit.state.canLoadMore, isFalse,
          reason: 'the cursor on screen belongs to the rows being replaced');

      gate.complete(_page(<CandidateSearchRow>[_row(_workerC)]));
      await applying;
      expect(cubit.state.switchingFilters, isFalse);
      expect(cubit.state.rows.single.workerId, _workerC);
    });

    test('a failed filter change is still the honest error state', () async {
      await cubit.load();
      api.onSearch = (_) async => throw const PayerApiException(503);

      await cubit.applyQuery(_turnerQuery);

      expect(cubit.state.status, CandidateSearchStatus.error);
      expect(cubit.state.rows, isEmpty);
      expect(cubit.state.reload, CandidateSearchReload.none);
      expect(cubit.state.rowsQuery, isNull);
    });

    test('kept rows keep the badges of the filters they came from', () async {
      await cubit.load();
      expect(cubit.state.filters?.roleLabel('mskill_cnc_turner'), 'CNC Turner');
      final Completer<CandidateSearchPage> gate =
          Completer<CandidateSearchPage>();
      api.onSearch = (_) => gate.future;

      const CandidateSearchQuery pick = CandidateSearchQuery(
        skillIds: <String>['mskill_cnc_turner'],
        city: 'Pune',
      );
      final Future<void> applying = cubit.applyQuery(pick);
      await Future<void>.delayed(Duration.zero);

      expect(cubit.state.query, pick, reason: 'the filter bar shows the pick');
      expect(cubit.state.pickedRoleLabel, isNull,
          reason: 'the dimmed rows were never "Related to" the new role');
      expect(cubit.state.unrecordableFilter, isFalse,
          reason: "no 'not recorded' clause on the old page's count");

      // A second change before the first lands: still the rows' own filters.
      // ignore: discarded_futures
      cubit.applyQuery(_turnerQuery);
      await Future<void>.delayed(Duration.zero);
      expect(cubit.state.pickedRoleLabel, isNull);

      gate.complete(_page(<CandidateSearchRow>[_row(_workerC)]));
      await applying;
      await Future<void>.delayed(Duration.zero);
      expect(cubit.state.switchingFilters, isFalse);
      expect(cubit.state.rowsQuery, isNull);
      expect(cubit.state.pickedRoleLabel, 'CNC Turner',
          reason: 'the new rows read the new filters');
    });

    test('refresh is quiet: no loading state, no dim, rows replaced in place',
        () async {
      await cubit.load();
      final List<CandidateSearchState> seen = <CandidateSearchState>[];
      final StreamSubscription<CandidateSearchState> sub =
          cubit.stream.listen(seen.add);
      api.onSearch = (_) async => _page(<CandidateSearchRow>[_row(_workerC)]);

      expect(await cubit.refresh(), isNull);
      await Future<void>.delayed(Duration.zero); // stream delivery
      await sub.cancel();

      expect(seen, isNotEmpty);
      expect(seen.map((CandidateSearchState s) => s.status),
          isNot(contains(CandidateSearchStatus.loading)));
      expect(seen.any((CandidateSearchState s) => s.switchingFilters), isFalse);
      expect(cubit.state.rows.single.workerId, _workerC);
    });

    test('a failed refresh keeps the rows and hands back the reason', () async {
      await cubit.load();
      api.onSearch = (_) async => throw const PayerApiException(429);

      final PayerFailure? failure = await cubit.refresh();

      expect(failure?.statusCode, 429);
      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(cubit.state.rows, hasLength(2));
      expect(cubit.state.reload, CandidateSearchReload.none);
    });

    test('a tab return keeps pages already scrolled through', () async {
      api.onSearch = (CandidateSearchQuery q) async => q.cursor == null
          ? _page(<CandidateSearchRow>[_row(_workerA)], next: 'c1')
          : _page(<CandidateSearchRow>[_row(_workerB)]);
      await cubit.load();
      await cubit.loadMore();
      final int searches = api.searches.length;
      final int history = api.unlockHistoryReads;

      await cubit.refresh(keepPages: true);

      expect(api.searches, hasLength(searches),
          reason: 'a first-page reload would throw away page 2 and the place');
      expect(api.unlockHistoryReads, history + 1);
      expect(cubit.state.rows, hasLength(2));

      // Pull-to-refresh (always at the top) does reload.
      await cubit.refresh();
      expect(api.searches, hasLength(searches + 1));
      expect(api.searches.last.cursor, isNull);
    });

    test('a page that adds nobody new marks paging as stalled', () async {
      api.onSearch = (_) async =>
          _page(<CandidateSearchRow>[_row(_workerA)], next: 'same');
      await cubit.load();
      await cubit.loadMore();

      expect(cubit.state.pagingStalled, isTrue);
      await cubit.refresh();
      expect(cubit.state.pagingStalled, isFalse,
          reason: 'a fresh first page starts over');
    });
  });

  group('on screen (360×640, animations disabled)', () {
    setUp(() async {
      await GetIt.instance.reset();
      setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
      locator.unregister<FindCubit>();
      locator.registerFactory<FindCubit>(
        () => FindCubit(locator<PayerApiClient>(), useRealFeed: true),
      );
    });

    Future<void> pump(WidgetTester tester, FindView view) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: Scaffold(
          body: FindScreen(onReveal: (_) {}, initialView: view),
        ),
      ));
    }

    /// The stale-row dim around [target] (its [BbDim]'s own opacity).
    double opacityAbove(WidgetTester tester, Finder target) => tester
        .widget<AnimatedOpacity>(find
            .descendant(
              of: find.ancestor(of: target, matching: find.byType(BbDim)).first,
              matching: find.byType(AnimatedOpacity),
            )
            .first)
        .opacity;

    testWidgets('the feed waits on candidate-card skeletons, not a spinner',
        (WidgetTester tester) async {
      final Completer<List<Applicant>> gate = Completer<List<Applicant>>();
      api.applicantGates[_jobA] = gate;
      await pump(tester, FindView.applicants);
      await tester.pump();

      expect(find.byType(BbSkeletonCandidateRow), findsWidgets);
      expect(find.byType(CircularProgressIndicator), findsNothing);

      gate.complete(<Applicant>[_applicant(_workerA)]);
      await tester.pumpAndSettle();
      expect(find.byType(BbSkeletonCandidateRow), findsNothing);
      expect(find.text(NameMask.workerLabel(_workerA)), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a job switch dims the rows to 60% under a thin bar',
        (WidgetTester tester) async {
      await pump(tester, FindView.applicants);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('VMC Operator'));
      await tester.pumpAndSettle();
      final Completer<List<Applicant>> gate = Completer<List<Applicant>>();
      api.applicantGates[_jobB] = gate;

      await tester.tap(find.text('VMC Operator'));
      await tester.pump();

      final Finder oldRow = find.text(NameMask.workerLabel(_workerA));
      expect(oldRow, findsOneWidget, reason: 'the list is never blanked');
      expect(opacityAbove(tester, oldRow), 0.6);
      expect(find.byKey(BbStaleFrame.barKey), findsOneWidget);

      gate.complete(<Applicant>[_applicant(_workerB)]);
      await tester.pumpAndSettle();
      final Finder newRow = find.text(NameMask.workerLabel(_workerB));
      expect(newRow, findsOneWidget);
      expect(opacityAbove(tester, newRow), 1);
      expect(find.byKey(BbStaleFrame.barKey), findsNothing);
    });

    testWidgets('an unlock confirmed after a switch lands stays on its job',
        (WidgetTester tester) async {
      final List<RevealArgs> revealed = <RevealArgs>[];
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: Scaffold(
          body: FindScreen(
            onReveal: revealed.add,
            initialView: FindView.applicants,
          ),
        ),
      ));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('VMC Operator'));
      await tester.pumpAndSettle();
      final Completer<List<Applicant>> gate = Completer<List<Applicant>>();
      api.applicantGates[_jobB] = gate;

      await tester.tap(find.text('VMC Operator'));
      await tester.pump();
      // The dimmed row from job A is still tappable (motion never blocks input).
      await tester.tap(find.text(kUnlockLabel).first);
      await tester.pump();
      await tester.pump();
      expect(find.text('Unlock for 1 credit'), findsOneWidget);

      // Job B's feed lands while the confirm dialog is open.
      gate.complete(<Applicant>[_applicant(_workerB)]);
      await tester.pump();
      await tester.pump();
      await tester.tap(find.text('Unlock for 1 credit'));
      await tester.pumpAndSettle();

      expect(api.unlockCalls.single, (_workerA, _jobA));
      expect(revealed.single.jobId, _jobA,
          reason: 'the reveal is bound to the same job as the spend');
      expect(tester.takeException(), isNull);
    });

    testWidgets('a filter change dims All candidates under a thin bar',
        (WidgetTester tester) async {
      await pump(tester, FindView.allCandidates);
      await tester.pumpAndSettle();
      final Completer<CandidateSearchPage> gate =
          Completer<CandidateSearchPage>();
      api.onSearch = (_) => gate.future;

      final CandidateSearchCubit cubit = locatorCubit(tester);
      // ignore: discarded_futures
      cubit.applyQuery(_turnerQuery);
      await tester.pump();
      await tester.pump(); // the cubit's stream delivers a microtask later

      final Finder oldRow = find.text(NameMask.workerLabel(_workerA));
      expect(oldRow, findsOneWidget);
      expect(opacityAbove(tester, oldRow), 0.6);
      expect(find.byKey(BbStaleFrame.barKey), findsOneWidget);

      gate.complete(_page(<CandidateSearchRow>[_row(_workerC)]));
      await tester.pumpAndSettle();
      expect(find.text(NameMask.workerLabel(_workerC)), findsOneWidget);
      expect(find.byKey(BbStaleFrame.barKey), findsNothing);
    });

    testWidgets('pull-to-refresh re-reads with the rows kept on screen',
        (WidgetTester tester) async {
      await pump(tester, FindView.applicants);
      await tester.pumpAndSettle();
      final Completer<List<Applicant>> gate = Completer<List<Applicant>>();
      api.applicantGates[_jobA] = gate;

      await tester.fling(
        find.text(NameMask.workerLabel(_workerA)),
        const Offset(0, 400),
        1000,
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(
          api.applicantFetches.where((String j) => j == _jobA), hasLength(2));
      expect(find.text(NameMask.workerLabel(_workerA)), findsOneWidget,
          reason: 'stale rows stay while the refresh runs');
      expect(find.byType(BbSkeletonCandidateRow), findsNothing);

      gate.complete(<Applicant>[_applicant(_workerC)]);
      await tester.pumpAndSettle();
      expect(find.text(NameMask.workerLabel(_workerC)), findsOneWidget);
    });

    testWidgets('the no-open-job state pulls to refresh too',
        (WidgetTester tester) async {
      api.jobs = <JobPosting>[];
      await pump(tester, FindView.applicants);
      await tester.pumpAndSettle();
      expect(find.text('No matched candidates yet'), findsOneWidget);

      api.jobs = <JobPosting>[_job(_jobA)]; // the first job just went live
      await tester.fling(
        find.text('No matched candidates yet'),
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();

      expect(find.text('No matched candidates yet'), findsNothing);
      expect(find.text(NameMask.workerLabel(_workerA)), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}

/// The All-candidates cubit the mounted view reads.
CandidateSearchCubit locatorCubit(WidgetTester tester) {
  final BuildContext context = tester.element(find.byType(BbRefreshIndicator));
  return context.read<CandidateSearchCubit>();
}

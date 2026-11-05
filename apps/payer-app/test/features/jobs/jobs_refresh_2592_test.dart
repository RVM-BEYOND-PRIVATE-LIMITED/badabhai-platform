import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/error/payer_failure.dart';
import 'package:payer_app/core/widgets/bb_skeleton.dart';
import 'package:payer_app/features/jobs/presentation/cubit/agency_jobs_cubit.dart'
    hide JobActionResult;
import 'package:payer_app/features/jobs/presentation/cubit/agency_jobs_cubit.dart'
    as agency show JobActionResult;
import 'package:payer_app/features/jobs/presentation/cubit/jobs_cubit.dart';
import 'package:payer_app/features/jobs/presentation/agency_jobs_screen.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';

/// #2592 (M4) on Jobs: the postings wait on job-card skeletons (not a
/// spinner), a re-read — pull-to-refresh, a return to the tab, the refetch
/// after a lifecycle action — keeps the list on screen, and a failed refresh
/// keeps it AND says why.
class _Api extends MockPayerApiClient {
  List<JobPosting> jobs = <JobPosting>[_job('Fitter')];
  Object? throwOnJobs;
  Completer<List<JobPosting>>? gate;
  int jobFetches = 0;

  /// One gate per read, in the order the reads are SENT.
  final List<Completer<List<JobPosting>>> jobReads =
      <Completer<List<JobPosting>>>[];
  final List<Completer<List<AgencyJobView>>> agencyReads =
      <Completer<List<AgencyJobView>>>[];

  List<AgencyJobView> agencyJobs = const <AgencyJobView>[];
  int agencyFetches = 0;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    jobFetches++;
    if (jobReads.isNotEmpty) return jobReads.removeAt(0).future;
    if (gate != null) return gate!.future;
    if (throwOnJobs != null) throw throwOnJobs!;
    return jobs;
  }

  @override
  Future<List<AgencyJobView>> fetchAgencyJobs() async {
    agencyFetches++;
    if (agencyReads.isNotEmpty) return agencyReads.removeAt(0).future;
    if (throwOnJobs != null) throw throwOnJobs!;
    return agencyJobs;
  }

  @override
  Future<AgencyJobView> closeAgencyJob(String id) async =>
      _agencyJob(status: 'closed');
}

AgencyJobView _agencyJob({String status = 'open'}) => AgencyJobView(
      id: 'agency-job-1',
      status: status,
      tradeKey: 'fitter',
      title: 'Fitter',
      city: 'Pune',
      applicantsReceived: 0,
    );

JobPosting _job(String title, {String wireStatus = 'open'}) => JobPosting(
      id: 'job-$title',
      title: title,
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.live,
      verified: false,
      boosted: false,
      wireStatus: wireStatus,
    );

void main() {
  late _Api api;
  setUp(() => api = _Api());

  group('JobsCubit', () {
    late JobsCubit cubit;
    setUp(() => cubit = JobsCubit(api));
    tearDown(() => cubit.close());

    test('the re-read after an action never blanks the postings', () async {
      await cubit.load();
      final List<JobsStatus> seen = <JobsStatus>[];
      final StreamSubscription<JobsState> sub =
          cubit.stream.listen((JobsState s) => seen.add(s.status));
      api.jobs = <JobPosting>[_job('Fitter', wireStatus: 'paused')];

      expect((await cubit.pause('job-Fitter')).success, isTrue);
      await Future<void>.delayed(Duration.zero); // stream delivery
      await sub.cancel();

      expect(seen, <JobsStatus>[JobsStatus.ready], reason: 'no loading frame');
      expect(cubit.state.jobs.single.wireStatus, 'paused');
    });

    test('a failed refresh keeps the list and hands back the reason', () async {
      await cubit.load();
      api.throwOnJobs = const PayerApiException(503);

      final PayerFailure? failure = await cubit.refresh();

      expect(failure?.kind, PayerFailureKind.server);
      expect(cubit.state.status, JobsStatus.ready);
      expect(cubit.state.jobs.single.title, 'Fitter');
    });

    test('a refresh sent before a pause never lands over the post-pause list',
        () async {
      await cubit.load();
      final Completer<List<JobPosting>> beforePause =
          Completer<List<JobPosting>>();
      final Completer<List<JobPosting>> afterPause =
          Completer<List<JobPosting>>();
      api.jobReads.addAll(<Completer<List<JobPosting>>>[
        beforePause,
        afterPause,
      ]);

      final Future<PayerFailure?> refreshing = cubit.refresh(); // a tab return
      final Future<JobActionResult> pausing = cubit.pause('job-Fitter');
      await Future<void>.delayed(Duration.zero);
      afterPause.complete(<JobPosting>[_job('Fitter', wireStatus: 'paused')]);
      expect((await pausing).success, isTrue);
      beforePause.complete(<JobPosting>[_job('Fitter')]); // lands LAST
      expect(await refreshing, isNull);

      expect(cubit.state.jobs.single.wireStatus, 'paused',
          reason: 'the pill matches the "Paused" toast');
    });

    test('a newer read failing never hides an older one still on its way',
        () async {
      await cubit.load();
      final Completer<List<JobPosting>> older = Completer<List<JobPosting>>();
      final Completer<List<JobPosting>> newer = Completer<List<JobPosting>>();
      api.jobReads.addAll(<Completer<List<JobPosting>>>[older, newer]);

      final Future<JobActionResult> pausing = cubit.pause('job-Fitter');
      await Future<void>.delayed(Duration.zero); // its re-read is on its way
      final Future<PayerFailure?> refreshing = cubit.refresh(); // a pull, later
      expect(api.jobFetches, 3, reason: 'both re-reads are in flight');
      newer.completeError(const PayerApiException(503));
      expect((await refreshing)?.kind, PayerFailureKind.server);
      older.complete(<JobPosting>[_job('Fitter', wireStatus: 'paused')]);
      expect((await pausing).success, isTrue);

      expect(cubit.state.status, JobsStatus.ready);
      expect(cubit.state.jobs.single.wireStatus, 'paused',
          reason: 'still newer than the list that was on screen');
    });

    test('a refresh sent before a pause never repaints over a failed re-read',
        () async {
      await cubit.load();
      final Completer<List<JobPosting>> beforePause =
          Completer<List<JobPosting>>();
      final Completer<List<JobPosting>> afterPause =
          Completer<List<JobPosting>>();
      api.jobReads.addAll(<Completer<List<JobPosting>>>[
        beforePause,
        afterPause,
      ]);

      final Future<PayerFailure?> refreshing = cubit.refresh(); // a tab return
      final Future<JobActionResult> pausing = cubit.pause('job-Fitter');
      await Future<void>.delayed(Duration.zero);
      expect(api.jobFetches, 3, reason: 'both re-reads are in flight');
      afterPause.completeError(const PayerApiException(503));
      expect((await pausing).success, isTrue);
      expect(cubit.state.status, JobsStatus.error);
      beforePause.complete(<JobPosting>[_job('Fitter')]); // lands LAST
      expect(await refreshing, isNull);

      expect(cubit.state.status, JobsStatus.error,
          reason: 'the pre-pause "Open" pill never comes back over the error');
    });

    test('refresh from the error state is the normal load', () async {
      api.throwOnJobs = const PayerApiException(503);
      await cubit.load();
      expect(cubit.state.status, JobsStatus.error);
      api.throwOnJobs = null;

      expect(await cubit.refresh(), isNull);
      expect(cubit.state.status, JobsStatus.ready);
    });
  });

  test('AgencyJobsCubit: a failed refresh keeps the list', () async {
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);
    api.agencyJobs = const <AgencyJobView>[
      AgencyJobView(
        id: 'agency-job-1',
        status: 'open',
        tradeKey: 'fitter',
        title: 'Fitter',
        city: 'Pune',
        applicantsReceived: 0,
      ),
    ];
    await cubit.load();
    api.throwOnJobs = const PayerApiException(503);

    final PayerFailure? failure = await cubit.refresh();

    expect(failure, isNotNull);
    expect(cubit.state.status, AgencyJobsStatus.ready);
    expect(cubit.state.jobs, hasLength(1));
  });

  test('AgencyJobsCubit: a refresh sent before a close never lands over it',
      () async {
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);
    api.agencyJobs = <AgencyJobView>[_agencyJob()];
    await cubit.load();
    final Completer<List<AgencyJobView>> beforeClose =
        Completer<List<AgencyJobView>>();
    final Completer<List<AgencyJobView>> afterClose =
        Completer<List<AgencyJobView>>();
    api.agencyReads.addAll(<Completer<List<AgencyJobView>>>[
      beforeClose,
      afterClose,
    ]);

    final Future<PayerFailure?> refreshing = cubit.refresh();
    final Future<agency.JobActionResult> closing =
        cubit.closePosting('agency-job-1');
    await Future<void>.delayed(Duration.zero);
    afterClose.complete(<AgencyJobView>[_agencyJob(status: 'closed')]);
    expect((await closing).success, isTrue);
    beforeClose.complete(<AgencyJobView>[_agencyJob()]);
    expect(await refreshing, isNull);

    expect(cubit.state.jobs.single.status, 'closed');
  });

  test(
      'AgencyJobsCubit: a refresh sent before a close never repaints over a '
      'failed re-read', () async {
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);
    api.agencyJobs = <AgencyJobView>[_agencyJob()];
    await cubit.load();
    final Completer<List<AgencyJobView>> beforeClose =
        Completer<List<AgencyJobView>>();
    final Completer<List<AgencyJobView>> afterClose =
        Completer<List<AgencyJobView>>();
    api.agencyReads.addAll(<Completer<List<AgencyJobView>>>[
      beforeClose,
      afterClose,
    ]);

    final Future<PayerFailure?> refreshing = cubit.refresh();
    final Future<agency.JobActionResult> closing =
        cubit.closePosting('agency-job-1');
    await Future<void>.delayed(Duration.zero);
    expect(api.agencyFetches, 3, reason: 'both re-reads are in flight');
    afterClose.completeError(const PayerApiException(503));
    expect((await closing).success, isTrue);
    expect(cubit.state.status, AgencyJobsStatus.error);
    beforeClose.complete(<AgencyJobView>[_agencyJob()]); // lands LAST
    expect(await refreshing, isNull);

    expect(cubit.state.status, AgencyJobsStatus.error,
        reason: 'the closed job never shows as open again');
  });

  group('on screen (360×640, animations disabled)', () {
    setUp(() async {
      await GetIt.instance.reset();
      setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    });

    Future<void> pump(WidgetTester tester, {Widget? screen}) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: Scaffold(body: screen ?? JobsScreen(onPost: () {})),
      ));
    }

    testWidgets('the postings wait on job-card skeletons, not a spinner',
        (WidgetTester tester) async {
      api.gate = Completer<List<JobPosting>>();
      await pump(tester);
      await tester.pump();

      expect(find.byType(BbSkeletonJobRow), findsWidgets);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.bySemanticsLabel('Loading your jobs'), findsOneWidget);

      api.gate!.complete(api.jobs);
      api.gate = null;
      await tester.pumpAndSettle();
      expect(find.byType(BbSkeletonJobRow), findsNothing);
      expect(find.text('Fitter'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('pull-to-refresh keeps the list on screen while it re-reads',
        (WidgetTester tester) async {
      await pump(tester);
      await tester.pumpAndSettle();
      api.gate = Completer<List<JobPosting>>();

      await tester.fling(find.text('Fitter'), const Offset(0, 400), 1000);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(api.jobFetches, 2);
      expect(find.text('Fitter'), findsOneWidget, reason: 'never blanked');
      expect(find.byType(BbSkeletonJobRow), findsNothing);

      api.gate!.complete(<JobPosting>[_job('Fitter'), _job('Welder')]);
      api.gate = null;
      await tester.pumpAndSettle();
      expect(find.text('Welder'), findsOneWidget);
    });

    testWidgets('a failed pull keeps the list and names the reason',
        (WidgetTester tester) async {
      await pump(tester);
      await tester.pumpAndSettle();
      api.throwOnJobs = const PayerApiException(503);

      await tester.fling(find.text('Fitter'), const Offset(0, 400), 1000);
      await tester.pumpAndSettle();

      expect(find.text('Fitter'), findsOneWidget);
      expect(find.text("Couldn't refresh"), findsOneWidget);
      expect(
        find.text(const PayerFailure(PayerFailureKind.server).message),
        findsOneWidget,
      );
    });

    testWidgets('an empty list still pulls to refresh',
        (WidgetTester tester) async {
      api.jobs = <JobPosting>[];
      await pump(tester);
      await tester.pumpAndSettle();
      expect(find.text('Fitter'), findsNothing);

      api.jobs = <JobPosting>[_job('Fitter')]; // posted from the web portal
      await tester.fling(
          find.byType(Scrollable).first, const Offset(0, 400), 1000);
      await tester.pumpAndSettle();

      expect(find.text('Fitter'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an empty agency list still pulls to refresh',
        (WidgetTester tester) async {
      await pump(tester, screen: AgencyJobsView(onPost: () {}));
      await tester.pumpAndSettle();
      expect(find.text('Fitter'), findsNothing);

      api.agencyJobs = <AgencyJobView>[_agencyJob()];
      await tester.fling(
          find.byType(Scrollable).first, const Offset(0, 400), 1000);
      await tester.pumpAndSettle();

      expect(find.text('Fitter'), findsWidgets, reason: 'the new card');
      expect(tester.takeException(), isNull);
    });
  });
}

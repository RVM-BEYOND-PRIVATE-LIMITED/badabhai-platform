import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/find/presentation/cubit/find_cubit.dart';

/// #365 — FindCubit carries the payer app's highest-stakes logic (the REAL
/// per-job feed + the credit SPEND) and had zero tests, while its siblings
/// RevealCubit/JobsCubit are covered. These lock the three seams that would
/// silently rot: the real-feed load (open postings → faceless applicants, with
/// an honest empty state), selectJob switching, and unlockApplicant — whose
/// grant-marking a later reveal's `unlockId` depends on, whose neutral DENY
/// must NEVER read as success, and whose OUTAGE must surface as
/// [FindStatus.error] AND rethrow (#348) rather than collapse into
/// `UnlockResult.unavailable()` (the bug #346 fixed one layer down).
class _ScriptedApi extends MockPayerApiClient {
  List<JobPosting> jobs = const <JobPosting>[];
  Map<String, List<Applicant>> applicantsByJob = <String, List<Applicant>>{};
  UnlockResult unlockResult = const UnlockResult.unavailable();

  Object? throwOnJobs;
  Object? throwOnApplicants;
  Object? throwOnUnlock;

  int jobFetches = 0;
  String? lastJobStatusFilter;
  final List<String> applicantFetches = <String>[];
  final List<({String workerId, String? jobId})> unlockCalls =
      <({String workerId, String? jobId})>[];

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    jobFetches++;
    lastJobStatusFilter = status;
    if (throwOnJobs != null) throw throwOnJobs!;
    return jobs;
  }

  @override
  Future<List<Applicant>> fetchApplicants(String jobId) async {
    applicantFetches.add(jobId);
    if (throwOnApplicants != null) throw throwOnApplicants!;
    return applicantsByJob[jobId] ?? const <Applicant>[];
  }

  @override
  Future<UnlockResult> unlock({
    required String workerId,
    String? jobId,
  }) async {
    unlockCalls.add((workerId: workerId, jobId: jobId));
    if (throwOnUnlock != null) throw throwOnUnlock!;
    return unlockResult;
  }
}

JobPosting _job(String? id, {String title = 'CNC Setter'}) => JobPosting(
      id: id,
      title: title,
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.review,
      verified: false,
      boosted: false,
    );

Applicant _applicant(String workerId, {int rank = 1}) => Applicant(
      workerId: workerId,
      rank: rank,
      score: 0.9,
      hot: false,
      pushEligible: false,
      experienceBand: '5-8 yrs',
      tradeLabel: 'CNC Setter',
      cityLabel: 'Pune',
    );

const String _jobA = '11111111-1111-4111-8111-111111111111';
const String _jobB = '22222222-2222-4222-8222-222222222222';
const String _workerA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const String _workerB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

void main() {
  late _ScriptedApi api;
  late FindCubit cubit;

  /// The REAL feed: two owned open postings, job A with two applicants.
  void seedTwoJobs() {
    api
      ..jobs = <JobPosting>[_job(_jobA), _job(_jobB, title: 'VMC Operator')]
      ..applicantsByJob = <String, List<Applicant>>{
        _jobA: <Applicant>[_applicant(_workerA), _applicant(_workerB, rank: 2)],
        _jobB: <Applicant>[_applicant(_workerB)],
      };
  }

  setUp(() {
    api = _ScriptedApi();
    cubit = FindCubit(api, useRealFeed: true);
  });

  tearDown(() => cubit.close());

  group('load — REAL per-job feed', () {
    test('open postings drive the faceless applicant list for the FIRST job',
        () async {
      seedTwoJobs();

      await cubit.load();

      expect(cubit.state.status, FindStatus.ready);
      expect(cubit.state.jobs.length, 2);
      expect(cubit.state.selectedJob?.id, _jobA);
      expect(cubit.state.isRealFeed, isTrue);
      expect(
        cubit.state.applicants.map((Applicant a) => a.workerId),
        <String>[_workerA, _workerB],
      );
      // The feed must be scoped to LIVE postings — a closed job can't be
      // filled, so an unscoped fetch would show dead work.
      expect(api.lastJobStatusFilter, 'open');
      expect(api.applicantFetches, <String>[_jobA]);
    });

    test('no owned open postings → empty state, and NO applicant fetch',
        () async {
      api.jobs = const <JobPosting>[];

      await cubit.load();

      expect(cubit.state.status, FindStatus.empty);
      expect(cubit.state.selectedJob, isNull);
      expect(cubit.state.applicants, isEmpty);
      expect(api.applicantFetches, isEmpty,
          reason: 'nothing is owned — there is no job id to query');
    });

    test('a posting with no usable id is not treated as ownable', () async {
      // `_loadRealFeed` filters on a non-empty id because `_loadApplicants`
      // force-unwraps it; an id-less row must fall to the empty state rather
      // than crash the tab.
      api.jobs = <JobPosting>[_job(null), _job('')];

      await cubit.load();

      expect(cubit.state.status, FindStatus.empty);
      expect(api.applicantFetches, isEmpty);
    });

    test('a jobs-fetch outage is an error state, never a fake empty state',
        () async {
      api.throwOnJobs = const PayerApiException(503);

      await cubit.load();

      expect(cubit.state.status, FindStatus.error);
      expect(cubit.state.status, isNot(FindStatus.empty),
          reason: 'an outage must not read as "you have no jobs — post one"');
    });

    test('an applicants-fetch outage is an error state', () async {
      seedTwoJobs();
      api.throwOnApplicants = const PayerApiException(500);

      await cubit.load();

      expect(cubit.state.status, FindStatus.error);
      expect(cubit.state.applicants, isEmpty);
    });
  });

  group('load — MOCK feed', () {
    test('uses the global candidate list and never touches the job routes',
        () async {
      final FindCubit mockCubit = FindCubit(api, useRealFeed: false);
      addTearDown(mockCubit.close);

      await mockCubit.load();

      expect(mockCubit.state.status, FindStatus.ready);
      expect(mockCubit.state.candidates, isNotEmpty);
      expect(mockCubit.state.isRealFeed, isFalse);
      expect(api.jobFetches, 0);
    });
  });

  group('selectJob', () {
    test('switches the feed to another owned job, keeping the selector list',
        () async {
      seedTwoJobs();
      await cubit.load();

      await cubit.selectJob(cubit.state.jobs[1]);

      expect(cubit.state.status, FindStatus.ready);
      expect(cubit.state.selectedJob?.id, _jobB);
      expect(cubit.state.jobs.length, 2,
          reason: 'the job selector must survive a switch');
      expect(
        cubit.state.applicants.single.workerId,
        _workerB,
      );
      expect(api.applicantFetches, <String>[_jobA, _jobB]);
    });

    test('re-selecting the current job is a no-op (no refetch, no flicker)',
        () async {
      seedTwoJobs();
      await cubit.load();

      await cubit.selectJob(cubit.state.selectedJob!);

      expect(api.applicantFetches, <String>[_jobA]);
      expect(cubit.state.status, FindStatus.ready);
    });

    test('a failed switch errors WITHOUT phantom-switching the selection',
        () async {
      seedTwoJobs();
      await cubit.load();
      api.throwOnApplicants = const PayerApiException(500);

      await cubit.selectJob(cubit.state.jobs[1]);

      expect(cubit.state.status, FindStatus.error);
      expect(cubit.state.selectedJob?.id, _jobA,
          reason: 'the header must not claim a job whose feed never loaded');
    });
  });

  group('unlockApplicant — the credit spend', () {
    test('spends against the OPAQUE worker UUID, scoped to the selected job',
        () async {
      seedTwoJobs();
      await cubit.load();
      api.unlockResult = const UnlockResult.granted(unlockId: 'unl-1');

      await cubit.unlockApplicant(cubit.state.applicants.first);

      expect(api.unlockCalls.single.workerId, _workerA);
      expect(api.unlockCalls.single.jobId, _jobA);
    });

    test('a GRANT marks exactly the unlocked applicant, carrying the unlockId',
        () async {
      seedTwoJobs();
      await cubit.load();
      api.unlockResult = const UnlockResult.granted(unlockId: 'unl-42');

      final UnlockResult result =
          await cubit.unlockApplicant(cubit.state.applicants[1]);

      expect(result.granted, isTrue);
      final Applicant first = cubit.state.applicants[0];
      final Applicant second = cubit.state.applicants[1];
      // Matching on the wrong id field is the regression this guards: the
      // reveal step reads `unlockId` off the row, and a double-marked or
      // mis-marked list either double-charges or blocks the reveal.
      expect(second.workerId, _workerB);
      expect(second.unlocked, isTrue);
      expect(second.unlockId, 'unl-42');
      expect(first.unlocked, isFalse);
      expect(first.unlockId, isNull);
      // The rest of the row must survive the copyWith.
      expect(second.rank, 2);
      expect(second.tradeLabel, 'CNC Setter');
      // A grant is not a reload: status/jobs/selection stay put.
      expect(cubit.state.status, FindStatus.ready);
      expect(cubit.state.selectedJob?.id, _jobA);
      expect(cubit.state.jobs.length, 2);
    });

    test('the neutral DENY is NOT success — nothing is marked unlocked',
        () async {
      seedTwoJobs();
      await cubit.load();
      api.unlockResult = const UnlockResult.unavailable();

      final UnlockResult result =
          await cubit.unlockApplicant(cubit.state.applicants.first);

      expect(result.granted, isFalse);
      expect(result.unlockId, isNull);
      expect(cubit.state.applicants.every((Applicant a) => !a.unlocked), isTrue,
          reason: 'a deny that marks the card unlocked strands the payer on a '
              '"View" button with no unlockId to reveal with');
      expect(cubit.state.status, FindStatus.ready,
          reason: 'a deny is a normal 200 — not an outage');
    });

    test('#348 — an OUTAGE emits FindStatus.error AND rethrows', () async {
      seedTwoJobs();
      await cubit.load();
      api.throwOnUnlock = const PayerApiException(503);

      await expectLater(
        cubit.unlockApplicant(cubit.state.applicants.first),
        throwsA(isA<PayerApiException>()),
      );

      // Both halves matter: the state keeps this cubit consistent with
      // load/selectJob, and the rethrow is what lets the tap handler offer a
      // retry instead of a silent no-op.
      expect(cubit.state.status, FindStatus.error);
    });

    test('an outage must never be swallowed into a neutral deny', () async {
      seedTwoJobs();
      await cubit.load();
      api.throwOnUnlock = const PayerApiException(500);

      UnlockResult? returned;
      try {
        returned = await cubit.unlockApplicant(cubit.state.applicants.first);
      } catch (_) {
        // expected
      }

      expect(returned, isNull,
          reason: 'conflating an outage with UnlockResult.unavailable() is the '
              'exact bug #346 fixed one layer down');
      expect(cubit.state.applicants.every((Applicant a) => !a.unlocked), isTrue);
    });
  });

  group('markUnlocked — MOCK list', () {
    test('flips only the matching candidate', () async {
      final FindCubit mockCubit = FindCubit(api, useRealFeed: false);
      addTearDown(mockCubit.close);
      await mockCubit.load();
      final int target = mockCubit.state.candidates.first.id;

      mockCubit.markUnlocked(target);

      for (final Candidate c in mockCubit.state.candidates) {
        expect(c.unlocked, c.id == target);
      }
    });
  });
}

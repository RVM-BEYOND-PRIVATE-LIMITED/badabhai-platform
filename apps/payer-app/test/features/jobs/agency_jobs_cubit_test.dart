import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/cubit/agency_jobs_cubit.dart';

/// #366 — AgencyJobsCubit (the agency My-jobs list + per-row lifecycle) had no
/// test, so a regression in its status-code mapping or its refetch-on-success
/// would pass CI. The one behaviour worth guarding hardest is the HONEST pause
/// copy: a pause maps to `closed` server-side (Phase-1 has no paused state), so
/// success copy that says "paused" would mislead an agency into thinking the
/// posting can be resumed.
class _ScriptedAgencyApi extends MockPayerApiClient {
  List<AgencyJobView> jobs = const <AgencyJobView>[];

  Object? throwOnFetch;
  Object? throwOnClose;
  Object? throwOnPause;

  int fetches = 0;
  final List<String> closed = <String>[];
  final List<String> paused = <String>[];

  @override
  Future<List<AgencyJobView>> fetchAgencyJobs() async {
    fetches++;
    if (throwOnFetch != null) throw throwOnFetch!;
    return jobs;
  }

  @override
  Future<AgencyJobView> closeAgencyJob(String id) async {
    closed.add(id);
    if (throwOnClose != null) throw throwOnClose!;
    return _transitionToClosed(id);
  }

  @override
  Future<AgencyJobView> pauseAgencyJob(String id) async {
    paused.add(id);
    if (throwOnPause != null) throw throwOnPause!;
    return _transitionToClosed(id);
  }

  AgencyJobView _transitionToClosed(String id) {
    final AgencyJobView row = jobs.firstWhere((AgencyJobView j) => j.id == id);
    final AgencyJobView next = _job(row.id, status: 'closed', title: row.title);
    jobs = jobs
        .map((AgencyJobView j) => j.id == id ? next : j)
        .toList(growable: false);
    return next;
  }
}

AgencyJobView _job(
  String id, {
  String status = 'open',
  String title = 'CNC Setter — Pune',
}) =>
    AgencyJobView(
      id: id,
      status: status,
      tradeKey: 'cnc_setter',
      title: title,
      city: 'Pune',
      applicantsReceived: 3,
    );

void main() {
  late _ScriptedAgencyApi api;
  late AgencyJobsCubit cubit;

  setUp(() {
    api = _ScriptedAgencyApi();
    cubit = AgencyJobsCubit(api);
  });

  tearDown(() => cubit.close());

  group('load', () {
    test('ready with the agency\'s own postings', () async {
      api.jobs = <AgencyJobView>[_job('j1'), _job('j2')];

      await cubit.load();

      expect(cubit.state.status, AgencyJobsStatus.ready);
      expect(cubit.state.jobs.map((AgencyJobView j) => j.id), <String>['j1', 'j2']);
    });

    test('an empty list is a legitimate ready state, not an error', () async {
      api.jobs = const <AgencyJobView>[];

      await cubit.load();

      expect(cubit.state.status, AgencyJobsStatus.ready);
      expect(cubit.state.jobs, isEmpty);
    });

    test('a fetch outage errors and keeps the last-known list', () async {
      api.jobs = <AgencyJobView>[_job('j1')];
      await cubit.load();

      api.throwOnFetch = const PayerApiException(503);
      await cubit.load();

      expect(cubit.state.status, AgencyJobsStatus.error);
      expect(cubit.state.jobs.length, 1,
          reason: 'an outage must not blank the list into "no postings"');
    });
  });

  group('closePosting', () {
    setUp(() async {
      api.jobs = <AgencyJobView>[_job('j1'), _job('j2')];
      await cubit.load();
      api.fetches = 0;
    });

    test('success refetches so the row\'s status pill updates', () async {
      final JobActionResult result = await cubit.closePosting('j1');

      expect(result.success, isTrue);
      expect(result.message, 'Closed — no longer taking applicants.');
      expect(api.closed, <String>['j1']);
      expect(api.fetches, 1, reason: 'the pill/buttons come from a refetch');
      expect(cubit.state.jobs.first.status, 'closed');
    });

    test('404 (unknown / not-owned) is a failure and does not refetch',
        () async {
      api.throwOnClose = const PayerApiException(404);

      final JobActionResult result = await cubit.closePosting('ghost');

      expect(result.success, isFalse);
      expect(result.message, "This job isn't available.");
      expect(api.fetches, 0);
      expect(cubit.state.jobs.first.status, 'open');
    });

    test('400 (already closed) says so, rather than a generic retry', () async {
      api.throwOnClose = const PayerApiException(400);

      final JobActionResult result = await cubit.closePosting('j1');

      expect(result.success, isFalse);
      expect(result.message, 'This job is already closed.');
    });

    test('an unmapped status is a neutral retry failure', () async {
      api.throwOnClose = const PayerApiException(500);

      final JobActionResult result = await cubit.closePosting('j1');

      expect(result.success, isFalse);
      expect(result.message, 'Could not update. Please try again.');
    });

    test('a transport error is reported as a network error', () async {
      api.throwOnClose = Exception('socket closed');

      final JobActionResult result = await cubit.closePosting('j1');

      expect(result.success, isFalse);
      expect(result.message, 'Network error. Check your connection.');
    });
  });

  group('pausePosting', () {
    setUp(() async {
      api.jobs = <AgencyJobView>[_job('j1')];
      await cubit.load();
      api.fetches = 0;
    });

    test('success tells the truth: a pause CLOSES the posting', () async {
      final JobActionResult result = await cubit.pausePosting('j1');

      expect(result.success, isTrue);
      // Phase-1 has no `paused` literal — the row comes back `closed`. Copy
      // that promised a resumable pause would be a lie about server state.
      expect(result.message,
          'Paused — the job is now closed (no separate paused state).');
      expect(api.paused, <String>['j1']);
      expect(cubit.state.jobs.single.status, 'closed');
    });

    test('shares the close error mapping (404 → not available)', () async {
      api.throwOnPause = const PayerApiException(404);

      final JobActionResult result = await cubit.pausePosting('j1');

      expect(result.success, isFalse);
      expect(result.message, "This job isn't available.");
      expect(api.fetches, 0);
    });
  });
}

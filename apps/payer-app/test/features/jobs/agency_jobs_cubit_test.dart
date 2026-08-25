import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/cubit/agency_jobs_cubit.dart';

/// #366 — AgencyJobsCubit (the agency My-jobs list + per-row lifecycle) had no
/// test, so a regression in its status-code mapping or its refetch-on-success
/// would pass CI. Since #1202 a pause is REVERSIBLE: pause → `paused`, resume →
/// `open`, only a close is terminal. The copy must reflect that (a pause is not
/// a close), and Resume must reach `POST /payer/agency/jobs/:id/resume`.
class _ScriptedAgencyApi extends MockPayerApiClient {
  List<AgencyJobView> jobs = const <AgencyJobView>[];

  Object? throwOnFetch;
  Object? throwOnClose;
  Object? throwOnPause;
  Object? throwOnResume;
  Object? throwOnUpdate;

  int fetches = 0;
  final List<String> closed = <String>[];
  final List<String> paused = <String>[];
  final List<String> resumed = <String>[];
  final List<String> updated = <String>[];
  String? lastUpdatedTitle;

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
    return _transitionTo(id, 'closed');
  }

  @override
  Future<AgencyJobView> pauseAgencyJob(String id) async {
    paused.add(id);
    if (throwOnPause != null) throw throwOnPause!;
    return _transitionTo(id, 'paused');
  }

  @override
  Future<AgencyJobView> resumeAgencyJob(String id) async {
    resumed.add(id);
    if (throwOnResume != null) throw throwOnResume!;
    return _transitionTo(id, 'open');
  }

  @override
  Future<AgencyJobView> updateAgencyJob(
    String id, {
    String? tradeKey,
    String? title,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
  }) async {
    updated.add(id);
    lastUpdatedTitle = title;
    if (throwOnUpdate != null) throw throwOnUpdate!;
    final AgencyJobView row = jobs.firstWhere((AgencyJobView j) => j.id == id);
    final AgencyJobView next =
        _job(row.id, status: row.status, title: title ?? row.title);
    jobs = jobs
        .map((AgencyJobView j) => j.id == id ? next : j)
        .toList(growable: false);
    return next;
  }

  AgencyJobView _transitionTo(String id, String status) {
    final AgencyJobView row = jobs.firstWhere((AgencyJobView j) => j.id == id);
    final AgencyJobView next = _job(row.id, status: status, title: row.title);
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

  group('editJob', () {
    setUp(() async {
      api.jobs = <AgencyJobView>[_job('j1', title: 'Old title')];
      await cubit.load();
      api.fetches = 0;
    });

    test('success PATCHes the job and refetches so the card updates', () async {
      final JobActionResult result = await cubit.editJob(
        'j1',
        title: 'New title',
        city: 'Pune',
      );

      expect(result.success, isTrue);
      expect(result.message, 'Job updated.');
      expect(api.updated, <String>['j1']);
      expect(api.lastUpdatedTitle, 'New title');
      expect(api.fetches, 1, reason: 'the edited card comes from a refetch');
      expect(cubit.state.jobs.single.title, 'New title');
    });

    test('404 (unknown / not-owned) is a failure and does not refetch',
        () async {
      api.throwOnUpdate = const PayerApiException(404);

      final JobActionResult result = await cubit.editJob('j1', title: 'x');

      expect(result.success, isFalse);
      expect(result.message, "This job isn't available.");
      expect(api.fetches, 0);
    });

    test('a transport error is reported as a network error', () async {
      api.throwOnUpdate = Exception('socket closed');

      final JobActionResult result = await cubit.editJob('j1', title: 'x');

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

    test('success reports a REVERSIBLE pause (#1202) and lands `paused`',
        () async {
      final JobActionResult result = await cubit.pausePosting('j1');

      expect(result.success, isTrue);
      // Since #1202 a pause is reversible — the row comes back `paused`, so the
      // copy invites a resume rather than implying a terminal close.
      expect(result.message, 'Paused — hidden from workers. Resume it anytime.');
      expect(api.paused, <String>['j1']);
      expect(api.fetches, 1, reason: 'the pill/buttons come from a refetch');
      expect(cubit.state.jobs.single.status, 'paused');
    });

    test('shares the close error mapping (404 → not available)', () async {
      api.throwOnPause = const PayerApiException(404);

      final JobActionResult result = await cubit.pausePosting('j1');

      expect(result.success, isFalse);
      expect(result.message, "This job isn't available.");
      expect(api.fetches, 0);
    });
  });

  group('resumePosting', () {
    setUp(() async {
      api.jobs = <AgencyJobView>[_job('j1', status: 'paused')];
      await cubit.load();
      api.fetches = 0;
    });

    test('success hits the resume endpoint, refetches, and lands `open`',
        () async {
      final JobActionResult result = await cubit.resumePosting('j1');

      expect(result.success, isTrue);
      expect(result.message, 'Resumed — live again for applicants.');
      expect(api.resumed, <String>['j1'],
          reason: 'Resume must reach POST /payer/agency/jobs/:id/resume');
      expect(api.fetches, 1, reason: 'the pill/buttons come from a refetch');
      expect(cubit.state.jobs.single.status, 'open');
    });

    test('404 (unknown / not-owned) is a failure and does not refetch',
        () async {
      api.throwOnResume = const PayerApiException(404);

      final JobActionResult result = await cubit.resumePosting('ghost');

      expect(result.success, isFalse);
      expect(result.message, "This job isn't available.");
      expect(api.fetches, 0);
    });

    test('a transport error is reported as a network error', () async {
      api.throwOnResume = Exception('socket closed');

      final JobActionResult result = await cubit.resumePosting('j1');

      expect(result.success, isFalse);
      expect(result.message, 'Network error. Check your connection.');
    });
  });
}

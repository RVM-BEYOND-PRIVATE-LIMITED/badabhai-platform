import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/cubit/jobs_cubit.dart';

/// JobsCubit.editJob (company `PATCH /payer/job-postings/:id`) — the content
/// edit added alongside publish/pause/resume/close. Guards that a saved edit
/// refetches the list (so the card reflects the new content) and that its
/// status-code mapping matches the other lifecycle actions.
class _ScriptedJobsApi extends MockPayerApiClient {
  List<JobPosting> jobs = const <JobPosting>[];

  Object? throwOnUpdate;
  int fetches = 0;
  final List<String> updated = <String>[];
  String? lastRoleTitle;
  String? lastVacancyBand;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    fetches++;
    return jobs;
  }

  @override
  Future<JobPosting> updateJob(
    String id, {
    String? orgLabel,
    String? roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    String? status,
  }) async {
    updated.add(id);
    lastRoleTitle = roleTitle;
    lastVacancyBand = vacancyBand;
    if (throwOnUpdate != null) throw throwOnUpdate!;
    final JobPosting row = jobs.firstWhere((JobPosting j) => j.id == id);
    final JobPosting next = _job(
      row.id!,
      wire: row.wireStatus ?? 'open',
      title: roleTitle ?? row.title,
    );
    jobs =
        jobs.map((JobPosting j) => j.id == id ? next : j).toList(growable: false);
    return next;
  }
}

JobPosting _job(
  String id, {
  String wire = 'open',
  String title = 'CNC Setter',
}) =>
    JobPosting(
      title: title,
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.live,
      verified: false,
      boosted: false,
      id: id,
      wireStatus: wire,
    );

void main() {
  late _ScriptedJobsApi api;
  late JobsCubit cubit;

  setUp(() {
    api = _ScriptedJobsApi();
    cubit = JobsCubit(api);
  });

  tearDown(() => cubit.close());

  group('editJob', () {
    setUp(() async {
      api.jobs = <JobPosting>[_job('j1', title: 'Old title')];
      await cubit.load();
      api.fetches = 0;
    });

    test('success PATCHes the editable fields and refetches', () async {
      final JobActionResult result = await cubit.editJob(
        'j1',
        roleTitle: 'New title',
        locationLabel: 'Pune',
        vacancyBand: '6-10',
      );

      expect(result.success, isTrue);
      expect(result.message, 'Job updated.');
      expect(api.updated, <String>['j1']);
      expect(api.lastRoleTitle, 'New title');
      expect(api.lastVacancyBand, '6-10');
      expect(api.fetches, 1, reason: 'the edited card comes from a refetch');
      expect(cubit.state.jobs.single.title, 'New title');
    });

    test('a 409 (illegal transition) is a neutral, honest failure', () async {
      api.throwOnUpdate = const PayerApiException(409);

      final JobActionResult result = await cubit.editJob('j1', roleTitle: 'x');

      expect(result.success, isFalse);
      expect(result.message, "This job can't be edited now.");
      expect(api.fetches, 0);
    });

    test('a transport error is reported as a network error', () async {
      api.throwOnUpdate = Exception('socket closed');

      final JobActionResult result = await cubit.editJob('j1', roleTitle: 'x');

      expect(result.success, isFalse);
      expect(result.message, 'Network error. Check your connection.');
    });
  });
}

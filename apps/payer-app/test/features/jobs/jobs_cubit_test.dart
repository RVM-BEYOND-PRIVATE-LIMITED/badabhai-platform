import 'dart:async';
import 'dart:io';

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
  List<JobPostingClearField>? lastClear;

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
    String? city,
    int? payMin,
    int? payMax,
    String? shift,
    String? area,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    List<String>? benefits,
    List<String>? requirements,
    String? neededBy,
    String? roleKind,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
    List<JobPostingClearField>? clear,
  }) async {
    updated.add(id);
    lastRoleTitle = roleTitle;
    lastVacancyBand = vacancyBand;
    lastClear = clear;
    if (throwOnUpdate != null) throw throwOnUpdate!;
    final JobPosting row = jobs.firstWhere((JobPosting j) => j.id == id);
    final JobPosting next = _job(
      row.id!,
      wire: row.wireStatus ?? 'open',
      title: roleTitle ?? row.title,
    );
    jobs = jobs
        .map((JobPosting j) => j.id == id ? next : j)
        .toList(growable: false);
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

  // #2594 — an action's refetch must keep the list mounted: flipping to
  // `loading` swaps the whole tab for a spinner, so the changed card could
  // never settle (collapse + fade) in place.
  group('lifecycle refetch', () {
    setUp(() async {
      api.jobs = <JobPosting>[_job('j1')];
      await cubit.load();
      api.fetches = 0;
    });

    for (final (String name, Future<JobActionResult> Function(JobsCubit) op)
        in <(String, Future<JobActionResult> Function(JobsCubit))>[
      ('pause', (JobsCubit c) => c.pause('j1')),
      ('resume', (JobsCubit c) => c.resume('j1')),
      ('close', (JobsCubit c) => c.closePosting('j1')),
    ]) {
      test('$name refetches without flipping the list to loading', () async {
        final List<JobsStatus> seen = <JobsStatus>[];
        final StreamSubscription<JobsState> sub =
            cubit.stream.listen((JobsState s) => seen.add(s.status));

        final JobActionResult result = await op(cubit);
        await sub.cancel();

        expect(result.success, isTrue);
        expect(api.fetches, 1, reason: 'the card comes from a refetch');
        expect(seen, isNot(contains(JobsStatus.loading)));
        expect(cubit.state.status, JobsStatus.ready);
      });
    }
  });

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

    test('a transport error is reported with the honest network reason',
        () async {
      api.throwOnUpdate = const SocketException('socket closed');

      final JobActionResult result = await cubit.editJob('j1', roleTitle: 'x');

      expect(result.success, isFalse);
      // Classified via PayerFailure, same honesty as load() — a real connection
      // problem, not a blanket 'network error' that also mislabels a timeout.
      expect(result.message, contains('internet'));
    });

    // #1652 — the fields to UNSET ride through to the API untouched.
    test('passes the clear list through to the PATCH', () async {
      final JobActionResult result = await cubit.editJob(
        'j1',
        clear: const <JobPostingClearField>[
          JobPostingClearField.area,
          JobPostingClearField.locationLabel,
        ],
      );

      expect(result.success, isTrue);
      expect(api.lastClear, <JobPostingClearField>[
        JobPostingClearField.area,
        JobPostingClearField.locationLabel,
      ]);
    });

    test('a set-and-cleared 400 names the real reason, not a retry', () async {
      api.throwOnUpdate =
          const PayerApiException(400, code: kJobEditSetAndClearedCode);

      final JobActionResult result = await cubit.editJob('j1', area: 'x');

      expect(result.success, isFalse);
      expect(result.message, kJobEditSetAndClearedMessage);
      expect(api.fetches, 0);
    });

    test('a validation 400 shows the field and reason', () async {
      api.throwOnUpdate = const PayerApiException(
        400,
        validationMessage: 'Job title: Must not contain a company name.',
      );

      final JobActionResult result = await cubit.editJob('j1', roleTitle: 'x');

      expect(result.success, isFalse);
      expect(result.message, 'Job title: Must not contain a company name.');
    });

    test('#2595 — a validation 400 hands every issue on by its field',
        () async {
      api.throwOnUpdate = const PayerApiException(
        400,
        validationMessage: 'Title must not contain a company name',
        fieldErrors: <String, String>{
          'role_title': 'Title must not contain a company name.',
          'description': 'Must not contain links.',
        },
      );

      final JobActionResult result = await cubit.editJob('j1', roleTitle: 'x');

      expect(result.success, isFalse);
      expect(result.fieldErrors, <String, String>{
        'role_title': 'Title must not contain a company name.',
        'description': 'Must not contain links.',
      });
    });

    test('any other 400 keeps the neutral retry copy', () async {
      api.throwOnUpdate = const PayerApiException(400);

      final JobActionResult result = await cubit.editJob('j1', roleTitle: 'x');

      expect(result.success, isFalse);
      expect(result.message, 'Could not update. Please try again.');
    });
  });

  // #2635 — a company job matches only within the 16 trades, so the server
  // refuses to put one live without a trade. The HTTP client types that 400
  // (`error.reason`); the cubit hands it on FLAGGED, so the screen opens the
  // trade picker instead of toasting a reason.
  group('posting_trade_required (#2635)', () {
    const PayerApiException tradeRequired = PayerApiException(
      400,
      code: kPostingTradeRequiredCode,
      validationMessage: kPostingTradeRequiredMessage,
      fieldErrors: <String, String>{'role_kind': kPostingTradeRequiredMessage},
    );

    setUp(() async {
      api.jobs = <JobPosting>[_job('j1', wire: 'draft')];
      await cubit.load();
      api.fetches = 0;
    });

    test('a refused publish is flagged for the trade picker', () async {
      api.throwOnUpdate = tradeRequired;

      final JobActionResult result = await cubit.publish('j1');

      expect(result.success, isFalse);
      expect(result.tradeRequired, isTrue);
      expect(result.message, 'Pick one of the 16 trades');
      // Pinned to the role control, so a form shows it AT the picker.
      expect(result.fieldErrors, <String, String>{
        'role_kind': 'Pick one of the 16 trades',
      });
      expect(api.fetches, 0, reason: 'nothing changed, so no refetch');
    });

    test('a refused role change on a live job is flagged the same way',
        () async {
      api.throwOnUpdate = tradeRequired;

      final JobActionResult result =
          await cubit.editJob('j1', roleKind: 'plumber');

      expect(result.tradeRequired, isTrue);
      expect(result.fieldErrors.keys, <String>['role_kind']);
    });

    test('any other refusal is not mistaken for it', () async {
      api.throwOnUpdate = const PayerApiException(
        400,
        validationMessage: 'Job title: Must not contain a company name.',
        fieldErrors: <String, String>{
          'role_title': 'Title must not contain a company name.',
        },
      );

      final JobActionResult result = await cubit.publish('j1');

      expect(result.tradeRequired, isFalse);
      expect(result.message, 'Job title: Must not contain a company name.');
    });

    test('a successful publish is never flagged', () async {
      final JobActionResult result = await cubit.publish('j1');

      expect(result.success, isTrue);
      expect(result.tradeRequired, isFalse);
    });
  });
}

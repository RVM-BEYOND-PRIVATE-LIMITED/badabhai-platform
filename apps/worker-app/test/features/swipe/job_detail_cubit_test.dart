import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/swipe/domain/jobs_repository.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/cubit/job_detail_cubit.dart';

class MockJobsRepository extends Mock implements JobsRepository {}

class MockSwipeRepository extends Mock implements SwipeRepository {}

const JobDetail _detail = JobDetail(
  jobId: 'job-1',
  title: 'CNC Operator',
  company: 'Sharma Works',
  location: 'Pimpri, Pune',
  shift: 'Day shift',
  payBand: '22,000–28,000/mo',
  duties: <String>['Operate'],
  requirements: <String>['Fanuc'],
  benefits: <String>['PF + ESI'],
);

void main() {
  late MockJobsRepository jobs;
  late MockSwipeRepository swipe;

  setUp(() {
    jobs = MockJobsRepository();
    swipe = MockSwipeRepository();
  });

  blocTest<JobDetailCubit, JobDetailState>(
    'load -> loading then ready with the detail',
    build: () {
      when(() => jobs.jobDetail(any())).thenAnswer((_) async => _detail);
      return JobDetailCubit(jobs, swipe);
    },
    act: (JobDetailCubit c) => c.load('job-1'),
    expect: () => const <JobDetailState>[
      JobDetailState(status: JobDetailStatus.loading),
      JobDetailState(status: JobDetailStatus.ready, detail: _detail),
    ],
  );

  blocTest<JobDetailCubit, JobDetailState>(
    'apply success -> applying then appliedNonce bump',
    build: () {
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank')))
          .thenAnswer((_) async {});
      return JobDetailCubit(jobs, swipe);
    },
    seed: () =>
        const JobDetailState(status: JobDetailStatus.ready, detail: _detail),
    act: (JobDetailCubit c) => c.apply(),
    expect: () => const <JobDetailState>[
      JobDetailState(
          status: JobDetailStatus.ready, detail: _detail, applying: true),
      JobDetailState(
          status: JobDetailStatus.ready, detail: _detail, appliedNonce: 1),
    ],
    verify: (_) => verify(() => swipe.applyToJob('job-1', rank: 1)).called(1),
  );

  blocTest<JobDetailCubit, JobDetailState>(
    'apply failure -> applying then applyErrorNonce bump',
    build: () {
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank')))
          .thenThrow(const NetworkFailure());
      return JobDetailCubit(jobs, swipe);
    },
    seed: () =>
        const JobDetailState(status: JobDetailStatus.ready, detail: _detail),
    act: (JobDetailCubit c) => c.apply(),
    expect: () => const <JobDetailState>[
      JobDetailState(
          status: JobDetailStatus.ready, detail: _detail, applying: true),
      JobDetailState(
          status: JobDetailStatus.ready, detail: _detail, applyErrorNonce: 1),
    ],
  );
}

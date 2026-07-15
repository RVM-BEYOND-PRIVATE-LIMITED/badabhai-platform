import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/cubit/job_detail_cubit.dart';

class MockSwipeRepository extends Mock implements SwipeRepository {}

/// The cubit no longer LOADS a job: it used to fetch a client-side mock that
/// invented the employer name and pay band from `jobId.hashCode`. The REAL job
/// now arrives from the feed row that was tapped, so the cubit only applies.
void main() {
  late MockSwipeRepository swipe;

  // Exactly what GET /feed returns — no company, no pay.
  const JobDetail realJob = JobDetail(
    jobId: 'j1',
    title: 'CNC Operator',
    city: 'Pune',
    area: 'Pimpri',
  );

  setUp(() => swipe = MockSwipeRepository());

  test('seeded with the REAL job handed over from the feed row', () {
    final JobDetailCubit cubit = JobDetailCubit(swipe, realJob);
    expect(cubit.state.detail, realJob);
    expect(cubit.state.applying, isFalse);
  });

  test('JobDetail carries no employer/pay and builds place from feed fields', () {
    expect(realJob.place, 'Pimpri, Pune');
    // City-only job (feed omits area) still renders honestly.
    expect(const JobDetail(jobId: 'j2', title: 'Welder', city: 'Pune').place,
        'Pune');
    // Nothing to show -> null, so the screen renders no location line at all
    // rather than inventing one.
    expect(const JobDetail(jobId: 'j3', title: 'Fitter').place, isNull);
  });

  blocTest<JobDetailCubit, JobDetailState>(
    'apply success -> applying then appliedNonce bumped',
    build: () {
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank')))
          .thenAnswer((_) async {});
      return JobDetailCubit(swipe, realJob);
    },
    act: (JobDetailCubit c) => c.apply(),
    expect: () => <JobDetailState>[
      const JobDetailState(detail: realJob, applying: true),
      const JobDetailState(detail: realJob, appliedNonce: 1),
    ],
    verify: (_) => verify(() => swipe.applyToJob('j1', rank: 1)).called(1),
  );

  blocTest<JobDetailCubit, JobDetailState>(
    'apply failure -> applyErrorNonce bumped, never a false success',
    build: () {
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank')))
          .thenThrow(const NetworkFailure());
      return JobDetailCubit(swipe, realJob);
    },
    act: (JobDetailCubit c) => c.apply(),
    expect: () => <JobDetailState>[
      const JobDetailState(detail: realJob, applying: true),
      const JobDetailState(detail: realJob, applyErrorNonce: 1),
    ],
  );

  // Re-entrancy guard: a double-tap must not double-apply.
  blocTest<JobDetailCubit, JobDetailState>(
    'concurrent apply calls only invoke the repo once',
    build: () {
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank'))).thenAnswer(
        (_) => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      return JobDetailCubit(swipe, realJob);
    },
    act: (JobDetailCubit c) {
      c.apply(); // in flight — do not await
      c.apply(); // dropped by the guard
    },
    wait: const Duration(milliseconds: 50),
    verify: (_) => verify(() => swipe.applyToJob('j1', rank: 1)).called(1),
  );
}

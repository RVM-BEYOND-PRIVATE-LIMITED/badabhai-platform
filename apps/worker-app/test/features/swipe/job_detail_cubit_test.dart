import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/swipe/domain/jobs_repository.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/cubit/job_detail_cubit.dart';

class MockSwipeRepository extends Mock implements SwipeRepository {}

class MockJobsRepository extends Mock implements JobsRepository {}

/// The cubit seeds the LIGHT job handed over from the tapped row (instant
/// header), then fetches the FULL posting from GET /jobs/:jobId (ADR-0024
/// addendum, 2026-07-16). A failed fetch NEVER wipes the light facts — it only
/// flags loadFailed for a quiet retry. Applying is unchanged.
void main() {
  late MockSwipeRepository swipe;
  late MockJobsRepository jobs;

  // Exactly what the feed row carries — the instant-header shape.
  const JobDetail lightJob = JobDetail(
    jobId: 'j1',
    title: 'CNC Operator',
    city: 'Pune',
    area: 'Pimpri',
  );

  // Exactly what GET /jobs/:jobId returns — still nothing employer-shaped.
  const JobDetail fullJob = JobDetail(
    jobId: 'j1',
    title: 'CNC Operator',
    city: 'Pune',
    area: 'Pimpri',
    tradeKey: 'cnc_operator',
    payMin: 16000,
    payMax: 26000,
    minExperienceYears: 0,
    maxExperienceYears: 2,
    neededBy: 'immediate',
    shift: 'day',
    description: 'CNC lathe par kaam.',
    requirements: <String>['Fanuc control'],
    benefits: <String>['PF + ESI'],
  );

  setUp(() {
    swipe = MockSwipeRepository();
    jobs = MockJobsRepository();
  });

  test('seeds the light job, starts loading, then swaps in the full detail',
      () async {
    when(() => jobs.jobDetail('j1')).thenAnswer((_) async => fullJob);
    final JobDetailCubit cubit = JobDetailCubit(jobs, swipe, lightJob);

    // Header renders INSTANTLY from the light detail while the fetch runs.
    expect(cubit.state.detail, lightJob);
    expect(cubit.state.loading, isTrue);
    expect(cubit.state.applying, isFalse);

    await Future<void>.delayed(Duration.zero);
    expect(cubit.state.detail, fullJob);
    expect(cubit.state.loading, isFalse);
    expect(cubit.state.loadFailed, isFalse);
    verify(() => jobs.jobDetail('j1')).called(1);
  });

  test('JobDetail carries no employer and builds place from real fields', () {
    expect(lightJob.place, 'Pimpri, Pune');
    // City-only job (source omits area) still renders honestly.
    expect(const JobDetail(jobId: 'j2', title: 'Welder', city: 'Pune').place,
        'Pune');
    // Nothing to show -> null, so the screen renders no location line at all
    // rather than inventing one.
    expect(const JobDetail(jobId: 'j3', title: 'Fitter').place, isNull);
  });

  test(
      'a failed fetch keeps the light title/place (never wiped) and flags '
      'loadFailed; retry() refetches', () async {
    when(() => jobs.jobDetail('j1')).thenThrow(const NetworkFailure());
    final JobDetailCubit cubit = JobDetailCubit(jobs, swipe, lightJob);
    await Future<void>.delayed(Duration.zero);

    expect(cubit.state.detail, lightJob); // what we have is real — keep it
    expect(cubit.state.loading, isFalse);
    expect(cubit.state.loadFailed, isTrue);

    when(() => jobs.jobDetail('j1')).thenAnswer((_) async => fullJob);
    await cubit.retry();

    expect(cubit.state.detail, fullJob);
    expect(cubit.state.loadFailed, isFalse);
    expect(cubit.state.loading, isFalse);
  });

  test(
      'the fetch-swap carries the opening surface\'s applicationAction '
      'forward (WA-2) — the wire body never has it', () async {
    when(() => jobs.jobDetail('j1')).thenAnswer((_) async => fullJob);
    final JobDetailCubit cubit = JobDetailCubit(
        jobs, swipe, lightJob.withApplicationAction('applied'));
    await Future<void>.delayed(Duration.zero);

    // Rich fields landed AND the applied gate survived the swap.
    expect(cubit.state.detail.payMin, 16000);
    expect(cubit.state.detail.alreadyApplied, isTrue);
    expect(cubit.state.detail.applicationAction, 'applied');
  });

  test('retry() is a no-op while a load is already in flight', () async {
    when(() => jobs.jobDetail('j1')).thenAnswer(
      (_) => Future<JobDetail>.delayed(
          const Duration(milliseconds: 20), () => fullJob),
    );
    final JobDetailCubit cubit = JobDetailCubit(jobs, swipe, lightJob);

    await cubit.retry(); // still loading — dropped
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(cubit.state.detail, fullJob);
    verify(() => jobs.jobDetail('j1')).called(1);
  });

  blocTest<JobDetailCubit, JobDetailState>(
    'apply success -> applying then appliedNonce bumped (flow unchanged)',
    build: () {
      when(() => jobs.jobDetail(any())).thenAnswer((_) async => fullJob);
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank')))
          .thenAnswer((_) async {});
      return JobDetailCubit(jobs, swipe, lightJob);
    },
    act: (JobDetailCubit c) async {
      // Let the create-time load land first so the sequence is deterministic.
      await Future<void>.delayed(Duration.zero);
      await c.apply();
    },
    expect: () => <JobDetailState>[
      const JobDetailState(detail: fullJob), // load complete
      const JobDetailState(detail: fullJob, applying: true),
      const JobDetailState(detail: fullJob, appliedNonce: 1),
    ],
    verify: (_) => verify(() => swipe.applyToJob('j1', rank: 1)).called(1),
  );

  blocTest<JobDetailCubit, JobDetailState>(
    'apply failure -> applyErrorNonce bumped, never a false success',
    build: () {
      when(() => jobs.jobDetail(any())).thenAnswer((_) async => fullJob);
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank')))
          .thenThrow(const NetworkFailure());
      return JobDetailCubit(jobs, swipe, lightJob);
    },
    act: (JobDetailCubit c) async {
      await Future<void>.delayed(Duration.zero);
      await c.apply();
    },
    expect: () => <JobDetailState>[
      const JobDetailState(detail: fullJob),
      const JobDetailState(detail: fullJob, applying: true),
      const JobDetailState(detail: fullJob, applyErrorNonce: 1),
    ],
  );

  // Re-entrancy guard: a double-tap must not double-apply.
  blocTest<JobDetailCubit, JobDetailState>(
    'concurrent apply calls only invoke the repo once',
    build: () {
      when(() => jobs.jobDetail(any())).thenAnswer((_) async => fullJob);
      when(() => swipe.applyToJob(any(), rank: any(named: 'rank'))).thenAnswer(
        (_) => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      return JobDetailCubit(jobs, swipe, lightJob);
    },
    act: (JobDetailCubit c) {
      c.apply(); // in flight — do not await
      c.apply(); // dropped by the guard
    },
    wait: const Duration(milliseconds: 50),
    verify: (_) => verify(() => swipe.applyToJob('j1', rank: 1)).called(1),
  );
}

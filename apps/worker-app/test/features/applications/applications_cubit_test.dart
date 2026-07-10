import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/applications/domain/applications_repository.dart';
import 'package:badabhai_worker_app/features/applications/presentation/cubit/applications_cubit.dart';

class MockApplicationsRepository extends Mock implements ApplicationsRepository {}

AppliedJob _job(String id, DateTime createdAt) => AppliedJob(
      jobId: id,
      tradeKey: 'cnc_operator',
      title: 'CNC',
      city: 'Pune',
      area: null,
      action: 'applied',
      reason: null,
      sourceSurface: 'feed',
      rank: null,
      createdAt: createdAt,
      updatedAt: createdAt,
    );

void main() {
  late MockApplicationsRepository repo;
  setUp(() => repo = MockApplicationsRepository());

  blocTest<ApplicationsCubit, ApplicationsState>(
    'load -> ready, NEWEST-FIRST (reverses the oldest-first response)',
    build: () {
      when(() => repo.appliedJobs()).thenAnswer((_) async => <AppliedJob>[
            _job('oldest', DateTime(2026, 6, 1)),
            _job('middle', DateTime(2026, 6, 3)),
            _job('newest', DateTime(2026, 6, 5)),
          ]);
      return ApplicationsCubit(repo);
    },
    act: (ApplicationsCubit c) => c.load(),
    expect: () => <Matcher>[
      isA<ApplicationsState>()
          .having((ApplicationsState s) => s.status, 'status',
              ApplicationsStatus.loading),
      isA<ApplicationsState>()
          .having((ApplicationsState s) => s.status, 'status',
              ApplicationsStatus.ready)
          .having(
              (ApplicationsState s) =>
                  s.jobs.map((AppliedJob j) => j.jobId).toList(),
              'order (newest-first)',
              <String>['newest', 'middle', 'oldest']),
    ],
  );

  blocTest<ApplicationsCubit, ApplicationsState>(
    'load with no applied jobs -> empty',
    build: () {
      when(() => repo.appliedJobs()).thenAnswer((_) async => <AppliedJob>[]);
      return ApplicationsCubit(repo);
    },
    act: (ApplicationsCubit c) => c.load(),
    expect: () => <Matcher>[
      isA<ApplicationsState>().having((ApplicationsState s) => s.status,
          'status', ApplicationsStatus.loading),
      isA<ApplicationsState>().having((ApplicationsState s) => s.status,
          'status', ApplicationsStatus.empty),
    ],
  );

  blocTest<ApplicationsCubit, ApplicationsState>(
    'load failure -> error',
    build: () {
      when(() => repo.appliedJobs()).thenThrow(const NetworkFailure());
      return ApplicationsCubit(repo);
    },
    act: (ApplicationsCubit c) => c.load(),
    expect: () => <Matcher>[
      isA<ApplicationsState>().having((ApplicationsState s) => s.status,
          'status', ApplicationsStatus.loading),
      isA<ApplicationsState>().having((ApplicationsState s) => s.status,
          'status', ApplicationsStatus.error),
    ],
  );
}

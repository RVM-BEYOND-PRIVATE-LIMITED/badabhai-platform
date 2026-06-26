import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/cubit/profile_tab_cubit.dart';

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

const ProfileSummary _summary = ProfileSummary(
  initials: 'RK',
  displayName: 'Ramesh Kumar',
  tradeLabel: 'CNC Operator',
  city: 'Pune',
  strength: 0.72,
);

void main() {
  late MockProfileSummaryRepository repo;
  setUp(() => repo = MockProfileSummaryRepository());

  blocTest<ProfileTabCubit, ProfileTabState>(
    'load -> loading then ready with the summary',
    build: () {
      when(() => repo.summary()).thenAnswer((_) async => _summary);
      return ProfileTabCubit(repo);
    },
    act: (ProfileTabCubit c) => c.load(),
    expect: () => const <ProfileTabState>[
      ProfileTabState(status: ProfileTabStatus.loading),
      ProfileTabState(status: ProfileTabStatus.ready, summary: _summary),
    ],
  );

  blocTest<ProfileTabCubit, ProfileTabState>(
    'load failure -> loading then failed',
    build: () {
      when(() => repo.summary()).thenThrow(const NetworkFailure());
      return ProfileTabCubit(repo);
    },
    act: (ProfileTabCubit c) => c.load(),
    expect: () => const <ProfileTabState>[
      ProfileTabState(status: ProfileTabStatus.loading),
      ProfileTabState(status: ProfileTabStatus.failed),
    ],
  );
}
